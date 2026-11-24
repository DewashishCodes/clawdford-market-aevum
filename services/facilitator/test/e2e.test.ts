// End to end: anvil (plain or Aevum fork) + real Deploy.s.sol + facilitator over HTTP with x402 headers.
// Opt in: FACILITATOR_E2E=anvil (MockTUSD8) or FACILITATOR_E2E=fork (real tUSD8 on a fork of Aevum).
import { spawn, type ChildProcess } from "node:child_process";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  keccak256,
  toHex,
  type Account,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import {
  agentVaultAbi,
  chainById,
  identityRegistryAbi,
  loadDeployment,
  mockTUSD8Abi,
  stallRegistryAbi,
  type Deployment,
} from "@clawdford/aevum";
import {
  HEADER_PAYMENT_REQUIRED,
  PaymentPayload,
  PaymentRequired,
  decodeHeader,
  encodeHeader,
  hashVaultMessage,
  networkOf,
  vaultDomain,
  vaultTypedData,
  type PaymentPayload as PaymentPayloadT,
  type PaymentRequirements,
} from "@clawdford/x402";
import { createApp } from "../src/app.js";
import { Rails } from "../src/rails.js";

const MODE = process.env.FACILITATOR_E2E;
const FORK = MODE === "fork";
const PORT = 8546;
const RPC = `http://127.0.0.1:${PORT}`;
const CHAIN_ID = FORK ? 440050 : 31337;
const PK0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const at = (i: number) => mnemonicToAccount("test test test test test test test test test test test junk", { addressIndex: i });
const deployer = at(0);
const seller = at(1);
const owner = at(2);
const facilitatorKey = at(3);
const agent = privateKeyToAccount(generatePrivateKey()); // holds no gas, only signs

const chain = { ...chainById(CHAIN_ID), rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = (account: Account) => createWalletClient({ chain, transport: http(RPC), account });

let anvil: ChildProcess;
let server: Server;
let base: string;
let d: Deployment;
const stall = { exact: 0n, stream: 0n, task: 0n };
let sessionId: bigint;

function run(cmd: string, args: string[], cwd: string, env: Record<string, string>) {
  return new Promise<void>((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: "pipe" });
    let out = "";
    p.stdout.on("data", (b) => (out += b));
    p.stderr.on("data", (b) => (out += b));
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} failed:\n${out}`))));
  });
}

/** Simulate (to get the return value), send as a legacy tx, wait. */
async function send(account: Account, address: Address, abi: readonly unknown[], functionName: string, args: unknown[]) {
  const { result, request } = await pub.simulateContract({ account, address, abi, functionName, args } as never);
  const hash = await wallet(account).writeContract({ ...(request as object), type: "legacy" } as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${functionName} reverted`);
  return result as unknown;
}

async function post(path: string, body: unknown) {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return res.json();
}

const now = async () => (await pub.getBlock()).timestamp;
let nonce = 0;

/** Seller side: a signed exact quote packed into a 402 PAYMENT-REQUIRED header. */
async function quote402(amount: bigint): Promise<string> {
  const quote = {
    stallId: stall.exact.toString(),
    amount: amount.toString(),
    resourceHash: keccak256(toHex("GET /translate?q=hello")),
    buyerSession: "0",
    validBefore: ((await now()) + 600n).toString(),
    quoteNonce: keccak256(toHex(`quote-${Math.random()}`)),
  };
  const quoteSig = await seller.signTypedData(vaultTypedData(vaultDomain(CHAIN_ID, d.AgentVault), "Quote", quote));
  return encodeHeader({
    x402Version: 2,
    resource: { url: "http://stall.local/translate" },
    accepts: [
      {
        scheme: "exact",
        network: networkOf(CHAIN_ID),
        amount: amount.toString(),
        asset: d.tUSD8,
        payTo: seller.address,
        maxTimeoutSeconds: 600,
        extra: { vault: d.AgentVault, stallId: stall.exact.toString(), quote, quoteSig },
      },
    ],
  });
}

/** Buyer side: decode the 402, sign an intent with the session key, return the facilitator request. */
async function pay(header: string) {
  const required = decodeHeader(PaymentRequired, header);
  const accepted = required.accepts[0]!;
  if (accepted.scheme !== "exact") throw new Error("expected exact");
  const domain = vaultDomain(CHAIN_ID, d.AgentVault);
  const intent = {
    quoteHash: hashVaultMessage(domain, "Quote", accepted.extra.quote),
    sessionId: sessionId.toString(),
    validBefore: ((await now()) + 300n).toString(),
    nonce: (++nonce).toString(),
  };
  const signature = await agent.signTypedData(vaultTypedData(domain, "PaymentIntent", intent));
  const payload: PaymentPayloadT = { x402Version: 2, accepted, payload: { intent, signature } };
  // the header round trip a seller would do
  const paymentPayload = decodeHeader(PaymentPayload, encodeHeader(payload));
  return { x402Version: 2, paymentPayload, paymentRequirements: accepted };
}

async function signed(primaryType: "OpenChannel" | "TopUp" | "CreateTask", msg: Record<string, string>) {
  return agent.signTypedData(vaultTypedData(vaultDomain(CHAIN_ID, d.AgentVault), primaryType, msg));
}

function req(accepted: PaymentRequirements, payload: unknown) {
  return { x402Version: 2, paymentPayload: { x402Version: 2, accepted, payload }, paymentRequirements: accepted };
}

const common = () => ({ network: networkOf(CHAIN_ID), asset: d.tUSD8, payTo: seller.address, maxTimeoutSeconds: 600 });

describe.skipIf(!MODE)(`facilitator e2e on ${MODE}`, () => {
  beforeAll(async () => {
    const forkArgs = FORK ? ["--fork-url", "https://rpc-test.qday.info", "--chain-id", "440050"] : [];
    anvil = spawn("anvil", ["--hardfork", "shanghai", "--port", String(PORT), "--silent", ...forkArgs], { stdio: "ignore" });
    for (let i = 0; ; i++) {
      try {
        await pub.getChainId();
        break;
      } catch {
        if (i > 100) throw new Error("anvil did not start");
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    const contracts = fileURLToPath(new URL("../../../contracts", import.meta.url));
    await run("forge", ["script", "script/Deploy.s.sol", "--rpc-url", RPC, "--broadcast", "--legacy"], contracts, {
      DEPLOYER_PRIVATE_KEY: PK0,
    });
    d = loadDeployment(CHAIN_ID);

    // tUSD8 for seller (stake) and owner (deposit)
    if (FORK) {
      const rich = loadDeployment(44005).deployer; // holds real tUSD8 on Aevum
      const test = createTestClient({ chain, mode: "anvil", transport: http(RPC) });
      await test.impersonateAccount({ address: rich });
      await test.setBalance({ address: rich, value: 10n ** 18n });
      const erc20 = createWalletClient({ chain, transport: http(RPC), account: rich });
      for (const to of [seller.address, owner.address]) {
        const hash = await erc20.writeContract({ address: d.tUSD8, abi: mockTUSD8Abi, functionName: "transfer", args: [to, 1_000_000n], type: "legacy" });
        await pub.waitForTransactionReceipt({ hash });
      }
    } else {
      for (const to of [seller.address, owner.address]) {
        await send(deployer, d.tUSD8, mockTUSD8Abi, "mint", [to, 1_000_000n]);
      }
    }

    // seller: identity + one stall per mode
    const identityId = (await send(seller, d.IdentityRegistry, identityRegistryAbi, "register", ["translate.test", "ipfs://card"])) as bigint;
    await send(seller, d.tUSD8, mockTUSD8Abi, "approve", [d.StallRegistry, 750_000n]);
    for (const [key, mode] of [["exact", 0], ["stream", 1], ["task", 2]] as const) {
      stall[key] = (await send(seller, d.StallRegistry, stallRegistryAbi, "createStall", [
        { identityId, payee: seller.address, quoteSigner: seller.address, category: 0, mode, unitPrice: 10_000n, unit: "call", endpoint: "http://stall.local", metadataURI: "ipfs://meta", stake: 250_000n },
      ])) as bigint;
    }

    // owner: deposit and a session for the agent
    await send(owner, d.tUSD8, mockTUSD8Abi, "approve", [d.AgentVault, 500_000n]);
    await send(owner, d.AgentVault, agentVaultAbi, "deposit", [500_000n]);
    sessionId = (await send(owner, d.AgentVault, agentVaultAbi, "createSession", [
      { agentKey: agent.address, perPaymentCap: 50_000n, dailyCap: 200_000n, totalCap: 300_000n, expiry: (await now()) + 86_400n, categoryMask: 1, agentCanApprove: false },
    ])) as bigint;

    const app = createApp({
      publicClient: pub as never,
      walletClient: wallet(facilitatorKey) as never,
      deployment: d,
      rails: new Rails(":memory:", { perIpPerDay: 100, perSessionPerDay: 100, perDay: 100 }),
      lowBalanceWei: 0n,
    });
    server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 180_000);

  afterAll(() => {
    server?.close();
    anvil?.kill();
  });

  it("lists the three schemes on this network", async () => {
    const s = await (await fetch(`${base}/supported`)).json();
    expect(s.kinds.map((k: { scheme: string }) => k.scheme)).toEqual(["exact", "batch-settlement", "escrow"]);
    expect(s.kinds[0].network).toBe(networkOf(CHAIN_ID));
  });

  it("verifies and settles an exact payment, then refuses the replay", async () => {
    const body = await pay(await quote402(10_000n));
    expect(await post("/verify", body)).toEqual({ isValid: true, payer: owner.address });

    const before = (await pub.readContract({ address: d.tUSD8, abi: mockTUSD8Abi, functionName: "balanceOf", args: [seller.address] })) as bigint;
    const settled = await post("/settle", body);
    expect(settled).toMatchObject({ success: true, network: networkOf(CHAIN_ID), amount: "10000", receiptId: "1", payer: owner.address });
    expect(settled.transaction).toMatch(/^0x[0-9a-f]{64}$/);
    const after = (await pub.readContract({ address: d.tUSD8, abi: mockTUSD8Abi, functionName: "balanceOf", args: [seller.address] })) as bigint;
    expect(after - before).toBe(9_700n); // 3% fee to the treasury

    expect(await post("/settle", body)).toMatchObject({ success: false, errorReason: "QuoteAlreadyUsed", transaction: "" });
  });

  it("refuses tampered requirements, over-cap quotes and malformed bodies", async () => {
    const body = await pay(await quote402(10_000n));
    const tampered = { ...body, paymentRequirements: { ...body.paymentRequirements, amount: "1" } };
    expect(await post("/verify", tampered)).toMatchObject({ isValid: false, invalidReason: "requirements_mismatch" });
    expect(await post("/verify", await pay(await quote402(60_000n)))).toMatchObject({ isValid: false, invalidReason: "PerPaymentCapExceeded" });
    expect(await post("/verify", { hello: "world" })).toEqual({ isValid: false, invalidReason: "invalid_payload" });
  });

  it("opens and tops up a stream channel", async () => {
    const accepted = { scheme: "batch-settlement", ...common(), amount: "1000", extra: { vault: d.AgentVault, stallId: stall.stream.toString(), unit: "call", minDeposit: "20000", maxAmount: "5000" } } as PaymentRequirements;
    const vb = ((await now()) + 300n).toString();
    const open = { sessionId: sessionId.toString(), stallId: stall.stream.toString(), deposit: "20000", validBefore: vb, nonce: (++nonce).toString() };
    const opened = await post("/settle", req(accepted, { action: "open", open, signature: await signed("OpenChannel", open) }));
    expect(opened).toMatchObject({ success: true, channelId: "1", amount: "20000" });

    const topUp = { channelId: "1", amount: "5000", validBefore: vb, nonce: (++nonce).toString() };
    expect(await post("/settle", req(accepted, { action: "topUp", topUp, signature: await signed("TopUp", topUp) }))).toMatchObject({ success: true, channelId: "1", payer: owner.address });

    const small = { ...open, deposit: "100", nonce: (++nonce).toString() };
    expect(await post("/verify", req(accepted, { action: "open", open: small, signature: await signed("OpenChannel", small) }))).toMatchObject({ invalidReason: "deposit_too_small" });
  });

  it("escrows a task", async () => {
    const accepted = { scheme: "escrow", ...common(), amount: "30000", extra: { vault: d.AgentVault, stallId: stall.task.toString() } } as PaymentRequirements;
    const t = (await now()) + 600n;
    const task = { sessionId: sessionId.toString(), stallId: stall.task.toString(), amount: "30000", specHash: keccak256(toHex("summarise this pdf")) as Hex, deadline: t.toString(), validBefore: t.toString(), nonce: (++nonce).toString() };
    expect(await post("/settle", req(accepted, { task, signature: await signed("CreateTask", task) }))).toMatchObject({ success: true, taskId: "1" });
  });

  it("refuses everything after the owner revokes the session", async () => {
    await send(owner, d.AgentVault, agentVaultAbi, "revokeSession", [sessionId]);
    const settled = await post("/settle", await pay(await quote402(10_000n)));
    expect(settled).toMatchObject({ success: false, errorReason: "RevokedSession" });

    const activity = await (await fetch(`${base}/activity`)).json();
    const reasons = activity.events.map((e: { ok: boolean; reason?: string }) => (e.ok ? "ok" : e.reason));
    expect(reasons).toEqual(["RevokedSession", "ok", "ok", "ok", "QuoteAlreadyUsed", "ok"]);
  });
});
