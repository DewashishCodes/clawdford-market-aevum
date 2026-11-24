// End to end: buyer SDK -> seller SDK server -> facilitator -> vault on anvil. Opt in: SDK_E2E=anvil or SDK_E2E=fork.
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { agentVaultAbi, identityRegistryAbi } from "@clawdford/aevum";
import { CHALLENGE_WINDOW, startChain, type TestChain } from "@clawdford/testkit";
import { createApp as createFacilitator, Rails } from "@clawdford/facilitator";
import { createBuyer, PaymentRefused, type Buyer } from "../src/buyer.js";
import { createSeller, serveAgentCard, type Seller } from "../src/seller.js";

const MODE = process.env.SDK_E2E;
// anvil / mnemonic keys 1 (seller) and 2 (owner)
const SELLER_KEY: Hex = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

let t: TestChain;
const servers: Server[] = [];
let shop: string;
let buyer: Buyer;
const sellers: Record<"exact" | "stream" | "task" | "license", Seller> = {} as never;

async function listen(app: express.Express) {
  const s = app.listen(0);
  servers.push(s);
  await new Promise((r) => s.once("listening", r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

async function refusedWith(p: Promise<unknown>) {
  try {
    await p;
  } catch (err) {
    if (err instanceof PaymentRefused) return err.code;
    throw err;
  }
  throw new Error("expected a refusal");
}

const vaultBalance = (who: `0x${string}`) =>
  t.pub.readContract({ address: t.d.AgentVault, abi: agentVaultAbi, functionName: "balanceOf", args: [who] });

describe.skipIf(!MODE)(`sdk e2e on ${MODE}`, () => {
  beforeAll(async () => {
    t = await startChain({ fork: MODE === "fork", port: 8548 });
    const chainCfg = { chainId: t.chainId, rpcUrl: t.rpc, deployment: t.d };

    const facilitator = await listen(
      createFacilitator({
        publicClient: t.pub as never,
        walletClient: t.wallet(t.accounts.facilitator) as never,
        deployment: t.d,
        rails: new Rails(":memory:", { perIpPerDay: 1000, perSessionPerDay: 1000, perDay: 1000 }),
        lowBalanceWei: 0n,
        minClaim: 1_000n,
      }),
    );

    for (const key of ["exact", "stream", "task", "license"] as const) {
      sellers[key] = createSeller({ ...chainCfg, stallId: t.stall[key], quoteKey: SELLER_KEY, ownerKey: SELLER_KEY, facilitatorUrl: facilitator, dbPath: ":memory:", claimThreshold: 4_000n });
    }
    const card = { name: "Test stalls", chainId: t.chainId, payee: t.accounts.seller.address, stallIds: Object.values(t.stall).map(String) };

    const app = express();
    app.use(express.json());
    app.get("/card.json", serveAgentCard(card));
    app.get("/shady-card.json", serveAgentCard({ ...card, payee: "0x000000000000000000000000000000000000dEaD" }));
    app.get("/translate", sellers.exact.paid({ mode: "exact", price: 10_000n }), (_req, res) => {
      res.json({ text: "hola", receiptId: res.locals.payment.receiptId });
    });
    app.get("/pricey", sellers.exact.paid({ mode: "exact", price: 100_000n }), (_req, res) => {
      res.json({ text: "never" });
    });
    app.get("/skill", sellers.license.paid({ mode: "license", price: 50_000n }), (_req, res) => {
      res.type("text/markdown").send("# Risk memo skill");
    });
    app.post(
      "/chat",
      sellers.stream.paid({ mode: "stream", unitPrice: 1_000n, unit: "1k tokens", maxUnits: (req) => Number(req.query.max ?? 5), meter: (_req, res) => res.locals.units, minDeposit: 20_000n }),
      (req, res) => {
        res.locals.units = req.body.units;
        res.json({ reply: `used ${req.body.units}` });
      },
    );
    app.post("/review", sellers.task.paid({ mode: "task", price: 30_000n }), (_req, res) => {
      res.status(202).json({ taskId: res.locals.payment.taskId });
    });
    shop = await listen(app);

    await t.send(t.accounts.seller, t.d.IdentityRegistry, identityRegistryAbi, "update", [t.identityId, `${shop}/card.json`]);
    buyer = createBuyer({ ...chainCfg, sessionKey: t.agentKey,sessionId: t.sessionId, budget: { perCall: 60_000n }, channelDeposit: 20_000n });
  }, 180_000);

  afterAll(() => {
    servers.forEach((s) => s.close());
    t?.stop();
  });

  it("pays an exact call and returns the receipt", async () => {
    const before = await t.balanceOf(t.accounts.seller.address);
    const r = await buyer.payingFetch<{ text: string; receiptId: string }>(`${shop}/translate`);
    expect(r.data.text).toBe("hola");
    expect(r.spent).toBe(10_000n);
    expect(r.receipt).toMatchObject({ success: true, receiptId: r.data.receiptId });
    expect((await t.balanceOf(t.accounts.seller.address)) - before).toBe(9_700n);
  });

  it("buys a license", async () => {
    const r = await buyer.payingFetch<string>(`${shop}/skill`);
    expect(r.data).toContain("Risk memo");
    expect(r.spent).toBe(50_000n);
  });

  it("streams with pay-as-you-go vouchers, tops up, claims, closes and refunds", async () => {
    const chat = (units: number, max = 5) =>
      buyer.payingFetch<{ reply: string }>(`${shop}/chat?max=${max}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ units }) });

    expect((await chat(2)).spent).toBe(2_000n); // opens a 20000 channel
    expect((await chat(3)).spent).toBe(3_000n);
    expect((await chat(1)).spent).toBe(1_000n);
    expect((await chat(9, 16)).spent).toBe(9_000n); // 16000 > 14000 headroom: tops up 20000 first
    const ch = buyer.channels.get(t.stall.stream)!;
    expect(ch).toMatchObject({ deposit: 40_000n, owed: 15_000n });

    // seller holds the voucher sent with the 4th call (6000 owed then); 6000 >= threshold 4000
    const [claim] = await sellers.stream.settleNow();
    expect(claim).toMatchObject({ success: true, amount: "6000" });

    const ownerBefore = await vaultBalance(t.accounts.owner.address);
    await buyer.closeChannel(t.stall.stream); // final voucher pays the last 9000
    await t.warp(CHALLENGE_WINDOW + 1);
    const results = await sellers.stream.settleNow();
    expect(results.at(-1)).toMatchObject({ success: true, amount: "25000" }); // finalize: 40000 - 15000
    expect((await vaultBalance(t.accounts.owner.address)) - ownerBefore).toBe(25_000n);
    expect(await sellers.stream.settleNow()).toEqual([]); // nothing left to do
  });

  it("escrows a task and the seller submits the result", async () => {
    const r = await buyer.payingFetch<{ taskId: string }>(`${shop}/review`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ doc: "contract.pdf" }) });
    expect(r.response.status).toBe(202);
    expect(r.spent).toBe(30_000n);
    await sellers.task.submitResult(BigInt(r.data.taskId), "looks fine", "ipfs://result");
    const task = await t.pub.readContract({ address: t.d.AgentVault, abi: agentVaultAbi, functionName: "getTask", args: [BigInt(r.data.taskId)] });
    expect(task.status).toBe(2); // Submitted
  });

  it("refuses an overpriced quote before signing anything", async () => {
    expect(await refusedWith(buyer.payingFetch(`${shop}/pricey`))).toBe("OVERPRICED");
  });

  it("refuses when the agent card payee does not match (Confirmation of Payee)", async () => {
    await t.send(t.accounts.seller, t.d.IdentityRegistry, identityRegistryAbi, "update", [t.identityId, `${shop}/shady-card.json`]);
    expect(await refusedWith(buyer.payingFetch(`${shop}/translate`))).toBe("PAYEE_MISMATCH");
    await t.send(t.accounts.seller, t.d.IdentityRegistry, identityRegistryAbi, "update", [t.identityId, `${shop}/card.json`]);
  });

  it("stops paying after the owner revokes the session", async () => {
    await t.send(t.accounts.owner, t.d.AgentVault, agentVaultAbi, "revokeSession", [t.sessionId]);
    const before = await t.balanceOf(t.accounts.seller.address);
    expect(await refusedWith(buyer.payingFetch(`${shop}/translate`))).toBe("SESSION_REVOKED");
    expect(await t.balanceOf(t.accounts.seller.address)).toBe(before);
  });
});
