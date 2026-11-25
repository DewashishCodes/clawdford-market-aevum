// The web app's server queries against the seeded demo market: indexer, stalls with Confirmation of Payee, stats,
// activity, owner console data, task board and the /sell 402 check. Opt in: WEB_E2E=anvil or WEB_E2E=fork.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentVaultAbi } from "@clawdford/aevum";
import { startChain, type TestChain } from "@clawdford/testkit";
import { createBuyer } from "@clawdford/sdk/buyer";
import { startDemoMarket, type DemoMarket } from "@clawdford/sellers/test-market";
import { createCtx, type Ctx } from "../lib/server/ctx";
import { activity, allowedUrl, checkSeller, listStalls, ownerView, sellerView, stallDetail, stats, taskBoard } from "../lib/server/queries";

const MODE = process.env.WEB_E2E;

let t: TestChain;
let market: DemoMarket;
let c: Ctx;
let sessionId: bigint;

describe.skipIf(!MODE)(`web queries e2e on ${MODE}`, () => {
  beforeAll(async () => {
    t = await startChain({ fork: MODE === "fork", port: 8552 });
    market = await startDemoMarket(t, { ownerDeposit: 1_400_000n });
    const s = await market.openSession();
    sessionId = s.sessionId;
    const buyer = createBuyer({ ...market.chainCfg, sessionKey: s.agentKey, sessionId, budget: { perCall: 200_000n } });
    await buyer.payingFetch(`${market.base}/s/cases?q=indemnity`);
    const task = await buyer.payingFetch<{ taskId: string }>(`${market.base}/s/review`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ document: "NDA" }) });
    await market.decide(task.data.taskId, true, "ok");
    await t.send(t.accounts.owner, t.d.AgentVault, agentVaultAbi, "approve", [BigInt(task.data.taskId)]);
    c = createCtx({ chainId: t.chainId, rpcUrl: t.rpc, deployment: t.d, facilitatorUrl: market.facilitator });
  }, 240_000);

  afterAll(() => {
    market?.close();
    t?.stop();
  });

  it("lists stalls with metadata, ratings and Confirmation of Payee", async () => {
    const stalls = await listStalls(c);
    const byName = new Map(stalls.map((s) => [s.name, s]));
    expect(byName.get("Case notes search")).toMatchObject({ category: "knowledge", mode: "exact", unitPrice: "1000", cop: "ok", active: true });
    expect(byName.get("Shady stall (demo fixture)")?.cop).toBe("mismatch");
    expect(stalls.find((s) => s.id === "1")?.cop).toBe("no_card"); // testkit stall with an ipfs card
  });

  it("counts payments of every kind in the stats", async () => {
    const s = await stats(c);
    expect(s.payments).toBe(2); // exact case search + released task
    expect(s.settled).toBe("101000");
    expect(s.latest[0]).toMatchObject({ kind: "task", stallId: market.stalls.review.toString() });
    expect(s.latest[0]?.time).toBeGreaterThan(0);
  });

  it("shows stall detail with receipts", async () => {
    const d = await stallDetail(c, market.stalls.cases);
    expect(d?.receipts).toHaveLength(1);
    expect(d?.receipts[0]).toMatchObject({ kind: "exact", amount: "1000", sessionId: sessionId.toString() });
    expect(await stallDetail(c, 999n)).toBeUndefined();
  });

  it("builds the activity feed newest first", async () => {
    const { rows, facilitator } = await activity(c);
    expect(rows[0]?.text).toMatch(/Task \d+ released/);
    expect(rows.map((r) => r.kind)).toEqual(expect.arrayContaining(["payment", "task", "session", "deposit", "stall"]));
    expect(facilitator?.address).toBe(t.accounts.facilitator.address);
  });

  it("gives the owner console its sessions and receipts", async () => {
    const o = await ownerView(c, t.accounts.owner.address);
    const s = o.sessions.find((x) => x.sessionId === sessionId.toString());
    expect(s).toMatchObject({ spentTotal: "101000", revoked: false, perPaymentCap: "200000" });
    expect(s?.categories).not.toContain("tool");
    expect(o.receipts.map((r) => r.kind).sort()).toEqual(["exact", "task"]);
    expect(o.receipts.every((r) => !r.rated)).toBe(true);
  });

  it("gives the seller dashboard earnings net of the fee per payment", async () => {
    const v = await sellerView(c, t.accounts.seller.address);
    expect(v.stalls.map((s) => s.name)).toContain("Case notes search");
    // 1000 (case search) + 100000 (review task), 3% fee rounded down per payment
    expect(v.totals).toMatchObject({ gross: "101000", net: "97970", payments: 2 });
    expect(v.stalls.find((s) => s.name === "Human review board")).toMatchObject({ payments: 1, net: "97000" });
    expect(v.tasks).toHaveLength(0); // released
    expect((await sellerView(c, t.accounts.owner.address)).stalls).toHaveLength(0);
  });

  it("shows the task board", async () => {
    expect((await taskBoard(c))[0]).toMatchObject({ status: "released", stallId: market.stalls.review.toString() });
  });

  it("runs the /sell 402 check", async () => {
    const card = `${market.base}/.well-known/agent-card.json`;
    const seller = t.accounts.seller.address;
    expect(await checkSeller(c, { endpoint: `${market.base}/s/cases?q=x`, payee: seller, agentCardURI: card })).toEqual({ ok: true, problems: [] });
    const wrong = await checkSeller(c, { endpoint: `${market.base}/s/cases?q=x`, payee: t.accounts.owner.address, agentCardURI: card });
    expect(wrong.problems).toHaveLength(2);
    expect((await checkSeller(c, { endpoint: `${market.base}/s/cases`, payee: seller, agentCardURI: card })).problems[0]).toContain("answered 400");
    expect((await checkSeller(c, { endpoint: "ftp://x", payee: seller, agentCardURI: card })).ok).toBe(false);
  });
});

describe("allowedUrl", () => {
  it("only allows public https hosts on Aevum", () => {
    expect(allowedUrl(44005, "https://stalls.example/s/x")).toBeDefined();
    for (const bad of ["http://stalls.example", "https://localhost/x", "https://127.0.0.1/x", "https://10.0.0.5/x", "https://192.168.1.2/", "https://169.254.169.254/latest", "https://[::1]/", "file:///etc/passwd", "nonsense"]) {
      expect(allowedUrl(44005, bad), bad).toBeUndefined();
    }
    expect(allowedUrl(440050, "http://127.0.0.1:4030/x")).toBeDefined(); // local chains may use local stalls
  });
});
