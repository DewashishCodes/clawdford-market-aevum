// The MCP server end to end, through a real MCP client: the demo prompt's tool calls against the seeded demo market.
// Opt in: MCP_E2E=anvil or MCP_E2E=fork.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { agentVaultAbi } from "@clawdford/aevum";
import { startChain, type TestChain } from "@clawdford/testkit";
import { startDemoMarket, type DemoMarket } from "@clawdford/sellers/test-market";
import { createMcpServer } from "../src/tools.js";

const MODE = process.env.MCP_E2E;

let t: TestChain;
let market: DemoMarket;
let client: Client;
let sessionId: bigint;
let agentAddress: `0x${string}`;
let skillsDir: string;
let connectAgent: () => Promise<Client>;

type Body = Record<string, any>;
async function call(name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  return { isError: r.isError ?? false, body: JSON.parse(r.content[0]!.text) as Body };
}

describe.skipIf(!MODE)(`mcp e2e on ${MODE}`, () => {
  beforeAll(async () => {
    t = await startChain({ fork: MODE === "fork", port: 8550 });
    market = await startDemoMarket(t, { ownerDeposit: 1_400_000n });
    const s = await market.openSession({ agentCanApprove: true });
    sessionId = s.sessionId;
    agentAddress = privateKeyToAccount(s.agentKey).address;
    skillsDir = mkdtempSync(join(tmpdir(), "clawdford-skills-"));

    const channelFile = join(skillsDir, "state", "channels.json");
    // A fresh MCP server process for the same agent; calling it again simulates a restart.
    connectAgent = async () => {
      const server = createMcpServer({ ...market.chainCfg, sessionKey: s.agentKey, sessionId, perCallBudget: 200_000n, channelDeposit: 50_000n, facilitatorUrl: market.facilitator, skillsDir, channelFile });
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await server.connect(serverSide);
      const c = new Client({ name: "e2e", version: "0.0.0" });
      await c.connect(clientSide);
      return c;
    };
    client = await connectAgent();
  }, 240_000);

  afterAll(async () => {
    await client?.close();
    market?.close();
    t?.stop();
  });

  it("offers the PRD tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((x) => x.name).sort()).toEqual(
      ["approve_task", "buy_license", "call_service", "close_channels", "create_task", "download_skill", "get_task", "market_search", "rate_service", "wallet_status"].sort(),
    );
  });

  it("market_search finds stalls with prices, usage and session permission", async () => {
    const { body } = await call("market_search", { query: "case notes" });
    expect(body.stalls[0]).toMatchObject({ stallId: market.stalls.cases.toString(), name: "Case notes search", mode: "exact", price: "0.001 tUSD8 per query", callWith: "call_service", allowedBySession: true, rating: "unrated" });
    expect(body.stalls[0].usage).toContain("q");
    const all = (await call("market_search")).body.stalls as Body[];
    expect(all.filter((x) => !x.name.startsWith("Stall "))).toHaveLength(8); // the testkit's own 4 stalls have no metadata
    expect(all.find((x) => x.stallId === market.stalls.shady.toString())?.allowedBySession).toBe(false);
    const inference = (await call("market_search", { category: "inference" })).body.stalls as Body[];
    expect(inference.map((x) => x.name)).toContain("LexModel");
    expect(inference.every((x) => x.category === "inference")).toBe(true);
    expect(body.budget).toMatchObject({ spentTotal: "0 tUSD8", remainingTotal: "2 tUSD8" });
  });

  it("wallet_status shows the caps", async () => {
    const { body } = await call("wallet_status");
    expect(body).toMatchObject({ sessionId: sessionId.toString(), revoked: false, agentCanApprove: true, caps: { perPayment: "0.2 tUSD8", daily: "1 tUSD8", total: "2 tUSD8" } });
    expect(body.allowedCategories).not.toContain("tool");
  });

  it("call_service pays an exact stall and a stream stall, with cost and budget", async () => {
    const cases = await call("call_service", { stallId: market.stalls.cases.toString(), query: { q: "indemnity" } });
    expect(cases.isError).toBe(false);
    expect(cases.body).toMatchObject({ cost: "0.001 tUSD8", budget: { spentTotal: "0.001 tUSD8" } });
    expect(cases.body.result.results.length).toBeGreaterThan(0);
    expect(cases.body.receiptId).toBeDefined();

    const chat = await call("call_service", { stallId: market.stalls.lexmodel.toString(), body: { messages: [{ role: "user", content: "Is this NDA one sided?" }] } });
    expect(chat.body).toMatchObject({ cost: "0.002 tUSD8", result: { model: "lexmodel-1" } });
    expect((await call("wallet_status")).body.openChannels).toHaveLength(1);
  });

  it("points the agent to the right tool for the stall's mode", async () => {
    const r = await call("call_service", { stallId: market.stalls.review.toString(), body: { document: "x" } });
    expect(r.isError).toBe(true);
    expect(r.body.error).toContain("create_task");
    expect((await call("call_service", { stallId: "999" })).body.error).toContain("unknown stall");
  });

  it("download_skill buys the license and installs SKILL.md", async () => {
    const { body } = await call("download_skill", { stallId: market.stalls["risk-memo-skill"].toString() });
    expect(body).toMatchObject({ name: "risk-memo-writer", cost: "0.2 tUSD8" });
    expect(readFileSync(join(skillsDir, "risk-memo-writer", "SKILL.md"), "utf8")).toContain("# Risk memo writer");
    // A second copy never overwrites the first.
    expect((await call("download_skill", { stallId: market.stalls["risk-memo-skill"].toString() })).body.name).toBe(`risk-memo-writer-stall${market.stalls["risk-memo-skill"]}`);
    expect(existsSync(join(skillsDir, "risk-memo-writer", "SKILL.md"))).toBe(true);
  });

  it("create_task, a person approves, get_task verifies the result, approve_task releases the escrow", async () => {
    const created = await call("create_task", { stallId: market.stalls.review.toString(), body: { document: "NDA v3", question: "OK to sign?" } });
    expect(created.body).toMatchObject({ cost: "0.1 tUSD8" });
    const taskId = created.body.taskId as string;
    expect((await call("get_task", { taskId })).body.status).toBe("open");

    expect((await market.decide(taskId, true, "Fine to sign.")).status).toBe(200);
    const submitted = (await call("get_task", { taskId })).body;
    expect(submitted).toMatchObject({ status: "submitted", resultVerified: true, result: { approved: true, note: "Fine to sign." } });

    const before = await t.balanceOf(t.accounts.seller.address);
    expect((await call("approve_task", { taskId })).body).toMatchObject({ released: true, amount: "0.1 tUSD8" });
    expect((await call("get_task", { taskId })).body.status).toBe("released");
    expect((await t.balanceOf(t.accounts.seller.address)) - before).toBe(97_000n);
  });

  it("refuses the shady stall with a readable code and charges nothing", async () => {
    const r = await call("call_service", { stallId: market.stalls.shady.toString(), query: { q: "x" } });
    expect(r.isError).toBe(true);
    expect(r.body).toMatchObject({ refused: "PAYEE_MISMATCH", charged: "nothing" });
  });

  it("rate_service needs gas on the agent key, then rates", async () => {
    const receiptId = (await call("call_service", { stallId: market.stalls.cases.toString(), query: { q: "warranty" } })).body.receiptId as string;
    expect((await call("rate_service", { receiptId, score: 5 })).body.error).toContain("no tQDAY");
    const hash = await t.wallet(t.accounts.deployer).sendTransaction({ to: agentAddress, value: parseEther("1"), type: "legacy" } as never);
    await t.pub.waitForTransactionReceipt({ hash });
    expect((await call("rate_service", { receiptId, score: 5 })).body).toMatchObject({ rated: true });
    expect((await call("market_search", { query: "case notes" })).body.stalls[0].rating).toBe("5.00 / 5 from 1");
  });

  it("after a restart, close_channels still closes the stream channel and pays the last call", async () => {
    await client.close();
    // A leftover entry from a reset chain: channel 1 belongs to another stall, so the agent must ignore it.
    const file = join(skillsDir, "state", "channels.json");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), "999": { channelId: "1", deposit: "50000", owed: "1000", facilitator: market.facilitator } }));
    client = await connectAgent();
    const { body } = await call("close_channels");
    expect(body.closed).toHaveLength(1);
    expect(body.closed[0]).toMatchObject({ paid: "0.002 tUSD8", refundAfterWindow: "0.048 tUSD8" });
  });

  it("stops paying once the owner revokes (kill switch)", async () => {
    await t.send(t.accounts.owner, t.d.AgentVault, agentVaultAbi, "revokeSession", [sessionId]);
    const r = await call("call_service", { stallId: market.stalls.cases.toString(), query: { q: "audit" } });
    expect(r.body).toMatchObject({ refused: "SESSION_REVOKED", charged: "nothing" });
    expect((await call("wallet_status")).body.revoked).toBe(true);
  });
});
