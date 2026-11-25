// PRD workflows 2 to 6 against the real demo stalls: seed -> sellers server -> facilitator -> vault.
// Opt in: SELLERS_E2E=anvil or SELLERS_E2E=fork. The LLM is faked so runs are deterministic.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keccak256, toHex, type Hex } from "viem";
import { agentVaultAbi } from "@clawdford/aevum";
import { CHALLENGE_WINDOW, startChain, type TestChain } from "@clawdford/testkit";
import { createBuyer, PaymentRefused, type Buyer } from "@clawdford/sdk/buyer";
import type { StallIds } from "../src/catalog.js";
import { REVIEW_TOKEN, startDemoMarket, type DemoMarket } from "./market.js";

const MODE = process.env.SELLERS_E2E;
const json = { "content-type": "application/json" };

let t: TestChain;
let market: DemoMarket;
let base: string;
let stalls: StallIds;
let buyer: Buyer;
let cappedBuyer: Buyer;
let sellers: DemoMarket["sellers"];

async function refusedWith(p: Promise<unknown>) {
  try {
    await p;
  } catch (err) {
    if (err instanceof PaymentRefused) return err.code;
    throw err;
  }
  throw new Error("expected a refusal");
}

const read = <T>(functionName: string, args: unknown[]) => t.pub.readContract({ address: t.d.AgentVault, abi: agentVaultAbi, functionName, args } as never) as Promise<T>;
const tokenBalance = (who: `0x${string}`) => t.balanceOf(who);

describe.skipIf(!MODE)(`demo stalls e2e on ${MODE}`, () => {
  beforeAll(async () => {
    t = await startChain({ fork: MODE === "fork", port: 8549 });
    // Workflow 1 session caps, but a 1.4 tUSD8 deposit, not 3: on the fork the tUSD8 comes from the Aevum deployer, which holds 5.
    market = await startDemoMarket(t, { ownerDeposit: 1_400_000n });
    ({ base, stalls, sellers } = market);
    const { agentKey, sessionId } = await market.openSession();
    buyer = createBuyer({ ...market.chainCfg, sessionKey: agentKey, sessionId, budget: { perCall: 200_000n }, channelDeposit: 50_000n });
    // A second agent with a per-payment cap below the license price, for the on-chain cap refusal.
    const capped = await market.openSession({ perPaymentCap: 100_000n });
    cappedBuyer = createBuyer({ ...market.chainCfg, sessionKey: capped.agentKey, sessionId: capped.sessionId, budget: { perCall: 1_000_000n } });
  }, 240_000);

  afterAll(() => {
    market?.close();
    t?.stop();
  });

  it("lists the eight stalls in the catalog", async () => {
    const catalog = (await (await fetch(`${base}/catalog`)).json()) as { key: string; stallId: string }[];
    expect(catalog.map((c) => c.key)).toEqual(["lexmodel", "clauses", "cases", "risk-memo-skill", "judge", "embeddings", "review", "shady"]);
    expect(catalog[0]?.stallId).toBe(stalls.lexmodel.toString());
  });

  it("rejects bad input before asking for payment", async () => {
    expect((await fetch(`${base}/s/cases`)).status).toBe(400);
    expect((await fetch(`${base}/s/lexmodel`, { method: "POST", headers: json, body: "{}" })).status).toBe(400);
  });

  it("workflow 2: exact pay for case search returns results and a receipt", async () => {
    const before = await tokenBalance(t.accounts.seller.address);
    const r = await buyer.payingFetch<{ results: { id: string }[]; receiptId: string }>(`${base}/s/cases?q=indemnity%20cap`);
    expect(r.spent).toBe(1_000n);
    expect(r.data.results[0]?.id).toBe("C-002");
    expect(r.receipt).toMatchObject({ success: true, receiptId: r.data.receiptId });
    expect((await tokenBalance(t.accounts.seller.address)) - before).toBe(970n); // minus the 3% fee
  });

  it("workflow 2: the draft judge grades through the LLM", async () => {
    const r = await buyer.payingFetch<{ grade: { score: number } }>(`${base}/s/judge`, { method: "POST", headers: json, body: JSON.stringify({ draft: "Risk memo draft" }) });
    expect(r.spent).toBe(1_000n);
    expect(r.data.grade.score).toBe(7);
  });

  it("workflow 3: LexModel and the dataset stream, the settler claims, close refunds the rest", async () => {
    const chat = (maxTokens: number) =>
      buyer.payingFetch<{ reply: string; model: string }>(`${base}/s/lexmodel`, { method: "POST", headers: json, body: JSON.stringify({ messages: [{ role: "user", content: "Is an uncapped indemnity risky?" }], maxTokens }) });
    const first = await chat(512); // opens a 50000 channel
    expect(first.data.model).toBe("lexmodel-1");
    expect(first.spent).toBe(2_000n);
    expect((await chat(1_500)).spent).toBe(4_000n);

    const rows = await buyer.payingFetch<{ rows: { risk: string }[] }>(`${base}/s/clauses?risk=high&limit=5`);
    expect(rows.data.rows).toHaveLength(5);
    expect(rows.data.rows.every((r) => r.risk === "high")).toBe(true);
    expect(rows.spent).toBe(2_500n);

    const [claim] = await sellers.lexmodel.settleNow(); // holds the voucher sent with the 2nd chat: 2000 owed then
    expect(claim).toMatchObject({ success: true, amount: "2000" });

    const vaultBefore = await read<bigint>("balanceOf", [t.accounts.owner.address]);
    await buyer.closeChannel(stalls.lexmodel); // final voucher pays the last 4000
    await buyer.closeChannel(stalls.clauses);
    await t.warp(CHALLENGE_WINDOW + 1);
    expect((await sellers.lexmodel.settleNow()).at(-1)).toMatchObject({ success: true, amount: "44000" });
    expect((await sellers.clauses.settleNow()).at(-1)).toMatchObject({ success: true, amount: "47500" });
    expect((await read<bigint>("balanceOf", [t.accounts.owner.address])) - vaultBefore).toBe(91_500n);
  });

  it("workflow 4: buys the risk memo skill license and downloads the file", async () => {
    const r = await buyer.payingFetch<string>(`${base}/s/risk-memo-skill`);
    expect(r.spent).toBe(200_000n);
    expect(r.data).toContain("name: risk-memo-writer");
    expect(await read<boolean>("licenses", [t.accounts.owner.address, stalls["risk-memo-skill"]])).toBe(true);
  });

  it("workflow 5: a person approves the review task, then the owner releases the funds", async () => {
    const r = await buyer.payingFetch<{ taskId: string; resultUrl: string }>(`${base}/s/review`, { method: "POST", headers: json, body: JSON.stringify({ document: "NDA v3", question: "OK to sign?" }) });
    expect(r.response.status).toBe(202);
    expect(r.spent).toBe(100_000n);

    expect((await fetch(`${base}/s/review/queue`)).status).toBe(401);
    const auth = { ...json, authorization: `Bearer ${REVIEW_TOKEN}` };
    const queue = (await (await fetch(`${base}/s/review/queue`, { headers: auth })).json()) as { taskId: string }[];
    expect(queue.map((q) => q.taskId)).toContain(r.data.taskId);

    const decided = await fetch(`${base}/s/review/${r.data.taskId}/decision`, { method: "POST", headers: auth, body: JSON.stringify({ approved: true, note: "Fine to sign." }) });
    expect(decided.status).toBe(200);
    const taskId = BigInt(r.data.taskId);
    const task = await read<{ status: number; resultHash: Hex }>("getTask", [taskId]);
    expect(task.status).toBe(2); // Submitted
    const result = await (await fetch(r.data.resultUrl)).text();
    expect(keccak256(toHex(result))).toBe(task.resultHash);

    const before = await tokenBalance(t.accounts.seller.address);
    await t.send(t.accounts.owner, t.d.AgentVault, agentVaultAbi, "approve", [taskId]);
    expect((await read<{ status: number }>("getTask", [taskId])).status).toBe(4); // Released
    expect((await tokenBalance(t.accounts.seller.address)) - before).toBe(97_000n);
  });

  it("workflow 5: the embeddings job delivers its result on its own", async () => {
    const r = await buyer.payingFetch<{ taskId: string; resultUrl: string }>(`${base}/s/embeddings`, { method: "POST", headers: json, body: JSON.stringify({ texts: ["indemnity", "termination"] }) });
    expect(r.spent).toBe(50_000n);
    const taskId = BigInt(r.data.taskId);
    for (let i = 0; (await read<{ status: number }>("getTask", [taskId])).status !== 2; i++) {
      if (i > 40) throw new Error("embeddings result never submitted");
      await new Promise((res) => setTimeout(res, 250));
    }
    const result = JSON.parse(await (await fetch(r.data.resultUrl)).text()) as { vectors: number[][] };
    expect(result.vectors).toHaveLength(2);
    expect(result.vectors[0]).toHaveLength(64);
  });

  it("workflow 6: refuses the shady stall before signing anything", async () => {
    const before = await tokenBalance(t.accounts.seller.address);
    expect(await refusedWith(buyer.payingFetch(`${base}/s/shady`))).toBe("PAYEE_MISMATCH");
    expect(await tokenBalance(t.accounts.seller.address)).toBe(before);
  });

  it("workflow 6: the vault rejects a payment above the session cap", async () => {
    expect(await refusedWith(cappedBuyer.payingFetch(`${base}/s/risk-memo-skill`))).toBe("CAP_EXCEEDED");
  });
});
