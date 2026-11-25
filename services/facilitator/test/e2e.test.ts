// End to end: anvil (plain or Aevum fork) + real Deploy.s.sol + facilitator over HTTP with x402 headers.
// Opt in: FACILITATOR_E2E=anvil (MockTUSD8) or FACILITATOR_E2E=fork (real tUSD8 on a fork of Aevum).
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keccak256, toHex, type Hex } from "viem";
import { TUSD8_EIP712 } from "@clawdford/aevum";
import { agentVaultAbi } from "@clawdford/aevum";
import { CHALLENGE_WINDOW, startChain, type TestChain } from "@clawdford/testkit";
import {
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
  type VaultPrimaryType,
} from "@clawdford/x402";
import { createApp } from "../src/app.js";
import { Rails } from "../src/rails.js";

const MODE = process.env.FACILITATOR_E2E;

let t: TestChain;
let server: Server;
let base: string;
let nonce = 0;

async function post(path: string, body: unknown) {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return res.json();
}

const domain = () => vaultDomain(t.chainId, t.d.AgentVault);
const agentSign = (type: VaultPrimaryType, msg: Record<string, string>) => t.accounts.agent.signTypedData(vaultTypedData(domain(), type, msg));
const common = () => ({ network: networkOf(t.chainId), asset: t.d.tUSD8, payTo: t.accounts.seller.address, maxTimeoutSeconds: 600 });

/** Seller side: a signed exact quote packed into a 402 PAYMENT-REQUIRED header. */
async function quote402(amount: bigint): Promise<string> {
  const quote = {
    stallId: t.stall.exact.toString(),
    amount: amount.toString(),
    resourceHash: keccak256(toHex("GET /translate?q=hello")),
    buyerSession: "0",
    validBefore: ((await t.now()) + 600n).toString(),
    quoteNonce: keccak256(toHex(`quote-${Math.random()}`)),
  };
  const quoteSig = await t.accounts.seller.signTypedData(vaultTypedData(domain(), "Quote", quote));
  return encodeHeader({
    x402Version: 2,
    resource: { url: "http://stall.local/translate" },
    accepts: [{ scheme: "exact", ...common(), amount: amount.toString(), extra: { vault: t.d.AgentVault, stallId: t.stall.exact.toString(), quote, quoteSig } }],
  });
}

/** Buyer side: decode the 402, sign an intent with the session key, return the facilitator request. */
async function pay(header: string) {
  const accepted = decodeHeader(PaymentRequired, header).accepts[0]!;
  if (accepted.scheme !== "exact") throw new Error("expected exact");
  const intent = {
    quoteHash: hashVaultMessage(domain(), "Quote", accepted.extra.quote),
    sessionId: t.sessionId.toString(),
    validBefore: ((await t.now()) + 300n).toString(),
    nonce: (++nonce).toString(),
  };
  const payload: PaymentPayloadT = { x402Version: 2, accepted, payload: { intent, signature: await agentSign("PaymentIntent", intent) } };
  const paymentPayload = decodeHeader(PaymentPayload, encodeHeader(payload)); // the round trip a seller would do
  return { x402Version: 2, paymentPayload, paymentRequirements: accepted };
}

function req(accepted: PaymentRequirements, payload: unknown) {
  return { x402Version: 2, paymentPayload: { x402Version: 2, accepted, payload }, paymentRequirements: accepted };
}

describe.skipIf(!MODE)(`facilitator e2e on ${MODE}`, () => {
  beforeAll(async () => {
    t = await startChain({ fork: MODE === "fork", port: 8546 });
    const app = createApp({
      publicClient: t.pub as never,
      walletClient: t.wallet(t.accounts.facilitator) as never,
      deployment: t.d,
      rails: new Rails(":memory:", { perIpPerDay: 100, perSessionPerDay: 100, perDay: 100 }),
      lowBalanceWei: 0n,
      minClaim: 10_000n,
    });
    server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 180_000);

  afterAll(() => {
    server?.close();
    t?.stop();
  });

  it("lists the three schemes on this network", async () => {
    const s = await (await fetch(`${base}/supported`)).json();
    expect(s.kinds.map((k: { scheme: string }) => k.scheme)).toEqual(["exact", "batch-settlement", "escrow"]);
    expect(s.kinds[0].network).toBe(networkOf(t.chainId));
  });

  it("verifies and settles an exact payment, then refuses the replay", async () => {
    const body = await pay(await quote402(10_000n));
    expect(await post("/verify", body)).toEqual({ isValid: true, payer: t.accounts.owner.address });

    const before = await t.balanceOf(t.accounts.seller.address);
    const settled = await post("/settle", body);
    expect(settled).toMatchObject({ success: true, network: networkOf(t.chainId), amount: "10000", receiptId: "1", payer: t.accounts.owner.address });
    expect(settled.transaction).toMatch(/^0x[0-9a-f]{64}$/);
    expect((await t.balanceOf(t.accounts.seller.address)) - before).toBe(9_700n); // 3% fee to the treasury

    expect(await post("/settle", body)).toMatchObject({ success: false, errorReason: "QuoteAlreadyUsed", transaction: "" });
  });

  it("refuses tampered requirements, over-cap quotes and malformed bodies", async () => {
    const body = await pay(await quote402(10_000n));
    const tampered = { ...body, paymentRequirements: { ...body.paymentRequirements, amount: "1" } };
    expect(await post("/verify", tampered)).toMatchObject({ isValid: false, invalidReason: "requirements_mismatch" });
    expect(await post("/verify", await pay(await quote402(60_000n)))).toMatchObject({ isValid: false, invalidReason: "PerPaymentCapExceeded" });
    expect(await post("/verify", { hello: "world" })).toEqual({ isValid: false, invalidReason: "invalid_payload" });
  });

  it("runs a channel: open, top up, claims (with the minimum), close and finalize", async () => {
    const accepted = { scheme: "batch-settlement", ...common(), amount: "1000", extra: { vault: t.d.AgentVault, stallId: t.stall.stream.toString(), unit: "call", minDeposit: "20000", maxAmount: "5000" } } as PaymentRequirements;
    const vb = ((await t.now()) + 300n).toString();
    const open = { sessionId: t.sessionId.toString(), stallId: t.stall.stream.toString(), deposit: "20000", validBefore: vb, nonce: (++nonce).toString() };
    expect(await post("/settle", req(accepted, { action: "open", open, signature: await agentSign("OpenChannel", open) }))).toMatchObject({ success: true, channelId: "1", amount: "20000" });

    const topUp = { channelId: "1", amount: "5000", validBefore: vb, nonce: (++nonce).toString() };
    expect(await post("/settle", req(accepted, { action: "topUp", topUp, signature: await agentSign("TopUp", topUp) }))).toMatchObject({ success: true, channelId: "1", payer: t.accounts.owner.address });

    const small = { ...open, deposit: "100", nonce: (++nonce).toString() };
    expect(await post("/verify", req(accepted, { action: "open", open: small, signature: await agentSign("OpenChannel", small) }))).toMatchObject({ invalidReason: "deposit_too_small" });

    const voucher = async (cumulativeAmount: string) => ({ voucher: { channelId: "1", cumulativeAmount }, signature: await agentSign("Voucher", { channelId: "1", cumulativeAmount }) });
    expect(await post("/claim", await voucher("4000"))).toMatchObject({ success: false, errorReason: "claim_below_minimum" });
    expect(await post("/claim", await voucher("12000"))).toMatchObject({ success: true, amount: "12000", channelId: "1" });

    expect(await post("/close", { channelId: "1" })).toMatchObject({ success: false, errorReason: "signature_required" });
    const closeSig = await agentSign("CloseChannel", { channelId: "1" });
    expect(await post("/close", { channelId: "1", signature: closeSig })).toMatchObject({ success: true });
    // closing: small claims allowed now, so the seller is never stranded
    expect(await post("/claim", await voucher("13000"))).toMatchObject({ success: true, amount: "1000" });
    expect(await post("/close", { channelId: "1" })).toMatchObject({ success: false, errorReason: "ChallengeWindowActive" });

    await t.warp(CHALLENGE_WINDOW + 1);
    const before = await t.pub.readContract({ address: t.d.AgentVault, abi: agentVaultAbi, functionName: "balanceOf", args: [t.accounts.owner.address] });
    expect(await post("/close", { channelId: "1" })).toMatchObject({ success: true, amount: "12000" });
    const after = await t.pub.readContract({ address: t.d.AgentVault, abi: agentVaultAbi, functionName: "balanceOf", args: [t.accounts.owner.address] });
    expect(after - before).toBe(12_000n); // 25000 deposited, 13000 claimed
  });

  it("escrows a task", async () => {
    const accepted = { scheme: "escrow", ...common(), amount: "30000", extra: { vault: t.d.AgentVault, stallId: t.stall.task.toString() } } as PaymentRequirements;
    const dl = (await t.now()) + 600n;
    const task = { sessionId: t.sessionId.toString(), stallId: t.stall.task.toString(), amount: "30000", specHash: keccak256(toHex("summarise this pdf")) as Hex, deadline: dl.toString(), validBefore: dl.toString(), nonce: (++nonce).toString() };
    expect(await post("/settle", req(accepted, { task, signature: await agentSign("CreateTask", task) }))).toMatchObject({ success: true, taskId: "1" });
  });

  it("refuses everything after the owner revokes the session", async () => {
    await t.send(t.accounts.owner, t.d.AgentVault, agentVaultAbi, "revokeSession", [t.sessionId]);
    expect(await post("/settle", await pay(await quote402(10_000n)))).toMatchObject({ success: false, errorReason: "RevokedSession" });

    const activity = await (await fetch(`${base}/activity`)).json();
    const reasons = activity.events.map((e: { ok: boolean; reason?: string }) => (e.ok ? "ok" : e.reason));
    expect(reasons).toEqual([
      "RevokedSession", "ok", // task
      "ok", "ChallengeWindowActive", "ok", "ok", "signature_required", "ok", "claim_below_minimum", // channel, newest first
      "ok", "ok", // top up, open
      "QuoteAlreadyUsed", "ok",
    ]);
  });

  it("relays a gasless EIP-3009 deposit, credited to the signer", async () => {
    const { owner } = t.accounts;
    await t.fund(owner.address, 100_000n);
    const before = (await t.pub.readContract({ address: t.d.AgentVault, abi: agentVaultAbi, functionName: "balanceOf", args: [owner.address] })) as bigint;
    const auth = { from: owner.address, to: t.d.AgentVault, value: 100_000n, validAfter: 0n, validBefore: (await t.now()) + 600n, nonce: keccak256(toHex("deposit-1")) };
    const signature = await owner.signTypedData({
      domain: { ...TUSD8_EIP712, chainId: t.chainId, verifyingContract: t.d.tUSD8 },
      types: { ReceiveWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
      primaryType: "ReceiveWithAuthorization",
      message: auth,
    });
    const body = { from: auth.from, amount: "100000", validAfter: "0", validBefore: auth.validBefore.toString(), nonce: auth.nonce, signature };
    expect(await post("/deposit", body)).toMatchObject({ success: true, payer: owner.address, amount: "100000" });
    const after = (await t.pub.readContract({ address: t.d.AgentVault, abi: agentVaultAbi, functionName: "balanceOf", args: [owner.address] })) as bigint;
    expect(after - before).toBe(100_000n);
    expect(await post("/deposit", body)).toMatchObject({ success: false }); // nonce used
    expect(await post("/deposit", { ...body, signature: "0x1234" })).toMatchObject({ success: false, errorReason: "invalid_signature" });
  });
});
