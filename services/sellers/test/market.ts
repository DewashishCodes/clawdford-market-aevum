// Test-only: the demo market on a test chain (facilitator + seeded stalls + sellers server) and owner sessions.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { agentVaultAbi, mockTUSD8Abi } from "@clawdford/aevum";
import type { TestChain } from "@clawdford/testkit";
import { createApp as createFacilitator, Rails } from "@clawdford/facilitator";
import { createSellersApp } from "../src/app.js";
import { CATEGORY } from "../src/catalog.js";
import type { Llm } from "../src/llm.js";
import { seedStalls, stallIdsOf } from "../src/seed.js";

export const SELLER_KEY: Hex = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // anvil key 1
export const REVIEW_TOKEN = "test-review-token";

/** Uses the whole completion budget, so cost is predictable: maxTokens 512 -> 1 unit, 1500 -> 2 units. */
export const fakeLlm: Llm = async (messages, maxTokens) => {
  const judging = messages[0]?.content.includes("grade");
  return { text: judging ? '{"score": 7, "verdict": "pass", "feedback": "clear"}' : "Uncapped indemnity: high risk.", tokens: maxTokens + 50 };
};

/** Every category except `tool` (PRD workflow 1). */
export const ALL_BUT_TOOL = (0xffffffff & ~(1 << CATEGORY.tool)) >>> 0;

async function listen(server: Server) {
  server.listen(0);
  await new Promise((r) => server.once("listening", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/**
 * Funds the owner's vault with `ownerDeposit` and the seller with stakes for 8 stalls, then starts a facilitator and
 * the sellers server on random ports and seeds the stalls against it.
 */
export async function startDemoMarket(t: TestChain, opts: { ownerDeposit: bigint; claimThreshold?: bigint; llm?: Llm }) {
  const chainCfg = { chainId: t.chainId, rpcUrl: t.rpc, deployment: t.d };
  const { seller, owner } = t.accounts;
  await t.fund(seller.address, 2_000_000n);
  await t.fund(owner.address, opts.ownerDeposit);
  await t.send(owner, t.d.tUSD8, mockTUSD8Abi, "approve", [t.d.AgentVault, opts.ownerDeposit]);
  await t.send(owner, t.d.AgentVault, agentVaultAbi, "deposit", [opts.ownerDeposit]);

  const servers: Server[] = [];
  const facilitatorServer = createServer(
    createFacilitator({
      publicClient: t.pub as never,
      walletClient: t.wallet(t.accounts.facilitator) as never,
      deployment: t.d,
      rails: new Rails(":memory:", { perIpPerDay: 1000, perSessionPerDay: 1000, perDay: 1000 }),
      lowBalanceWei: 0n,
      minClaim: 1_000n,
    }),
  );
  servers.push(facilitatorServer);
  const facilitator = await listen(facilitatorServer);

  // Listen first so the seed can register the real agent card URLs.
  const server = createServer();
  servers.push(server);
  const base = await listen(server);
  const stalls = stallIdsOf(await seedStalls({ ...chainCfg, sellerKey: SELLER_KEY, baseUrl: base }));
  const built = createSellersApp({ ...chainCfg, stalls, sellerKey: SELLER_KEY, facilitatorUrl: facilitator, baseUrl: base, shadyPayee: "0x000000000000000000000000000000000000dEaD", llm: opts.llm ?? fakeLlm, reviewToken: REVIEW_TOKEN, dbPath: () => ":memory:", claimThreshold: opts.claimThreshold ?? 1_000n });
  server.on("request", built.app);

  /** Owner opens a session for a fresh agent key: workflow 1 caps unless overridden. */
  async function openSession(o: { perPaymentCap?: bigint; agentCanApprove?: boolean } = {}) {
    const agentKey = generatePrivateKey();
    const sessionId = (await t.send(owner, t.d.AgentVault, agentVaultAbi, "createSession", [
      {
        agentKey: privateKeyToAccount(agentKey).address,
        perPaymentCap: o.perPaymentCap ?? 200_000n,
        dailyCap: 1_000_000n,
        totalCap: 2_000_000n,
        expiry: (await t.now()) + 7_200n,
        categoryMask: ALL_BUT_TOOL,
        agentCanApprove: o.agentCanApprove ?? false,
      },
    ])) as bigint;
    return { agentKey, sessionId };
  }

  /** Reviewer decides a human review task, as the web /tasks page will. */
  const decide = (taskId: string, approved: boolean, note = "") =>
    fetch(`${base}/s/review/${taskId}/decision`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${REVIEW_TOKEN}` }, body: JSON.stringify({ approved, note }) });

  return { chainCfg, base, facilitator, stalls, sellers: built.sellers, openSession, decide, close: () => servers.forEach((s) => s.close()) };
}

export type DemoMarket = Awaited<ReturnType<typeof startDemoMarket>>;
