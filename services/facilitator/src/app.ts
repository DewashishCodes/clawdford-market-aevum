import express, { type Request } from "express";
import {
  BaseError,
  ContractFunctionRevertedError,
  parseSignature,
  parseEventLogs,
  type Account,
  type Address,
  type Chain,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { agentVaultAbi, type Deployment } from "@clawdford/aevum";
import {
  ApproveRequest,
  DepositRequest,
  ClaimRequest,
  CloseRequest,
  FacilitatorRequest,
  X402_VERSION,
  networkOf,
  type SettlementResponse,
} from "@clawdford/x402";
import { plan, type Planned } from "./vault.js";
import type { Rails } from "./rails.js";

export interface FacilitatorDeps {
  publicClient: PublicClient;
  walletClient: WalletClient<Transport, Chain, Account>;
  deployment: Deployment;
  rails: Rails;
  /** Warn (and flag in /activity) when the gas wallet drops below this many wei. */
  lowBalanceWei: bigint;
  /** Smallest voucher claim we pay gas for while a channel is open (closing channels are always claimable). */
  minClaim: bigint;
}

type Checked =
  | { ok: true; planned: Planned; payer: Address }
  | { ok: false; reason: string; planned?: Planned; payer?: Address };

/** viem error to a reason code: the vault's custom error name when it reverted, else a generic code. */
function reasonOf(err: unknown): string {
  if (err instanceof BaseError) {
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) return reverted.data?.errorName ?? "reverted";
  }
  return "simulation_failed";
}

export function createApp(deps: FacilitatorDeps) {
  const { publicClient, walletClient, deployment: d, rails } = deps;
  const vault = { abi: agentVaultAbi, address: d.AgentVault } as const;
  const network = networkOf(d.chainId);
  const facilitator = walletClient.account.address;

  // One send at a time: keeps our own tx nonces in order and stops two relays of one signed message racing.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>) => {
    const run = queue.then(fn);
    queue = run.catch(() => undefined);
    return run;
  };

  const getChannel = (channelId: bigint) =>
    publicClient.readContract({ ...vault, functionName: "getChannel", args: [channelId] });

  /** Payer lookup, daily limits (when `ip` is given) and an eth_call of the vault function. */
  async function check(planned: Planned | string, ip: string | undefined): Promise<Checked> {
    if (typeof planned === "string") return { ok: false, reason: planned };
    if (planned.channelId !== undefined && planned.sessionId === 0n) {
      planned.sessionId = (await getChannel(planned.channelId)).sessionId;
    }
    const payer = planned.payer ?? (await publicClient.readContract({ ...vault, functionName: "getSession", args: [planned.sessionId] })).owner;
    if (ip !== undefined) {
      const limited = rails.check(ip, planned.sessionId.toString());
      if (limited) return { ok: false, reason: limited, planned, payer };
    }
    try {
      await publicClient.simulateContract({ ...vault, ...planned.call, account: facilitator } as never);
    } catch (err) {
      return { ok: false, reason: reasonOf(err), planned, payer };
    }
    return { ok: true, planned, payer };
  }

  const planPayment = (body: unknown): Planned | string => {
    const parsed = FacilitatorRequest.safeParse(body);
    return parsed.success ? plan(parsed.data, d) : "invalid_payload";
  };

  async function planClaim(body: unknown): Promise<Planned | string> {
    const parsed = ClaimRequest.safeParse(body);
    if (!parsed.success) return "invalid_payload";
    const { voucher, signature } = parsed.data;
    const channelId = BigInt(voucher.channelId);
    const cumulative = BigInt(voucher.cumulativeAmount);
    const ch = await getChannel(channelId);
    const delta = cumulative > ch.claimed ? cumulative - ch.claimed : 0n;
    if (ch.closeAt === 0n && delta < deps.minClaim) return "claim_below_minimum";
    return {
      call: { functionName: "claim", args: [channelId, cumulative, signature] },
      sessionId: ch.sessionId,
      channelId,
      action: "claim",
      amount: delta.toString(),
    };
  }

  async function planClose(body: unknown): Promise<Planned | string> {
    const parsed = CloseRequest.safeParse(body);
    if (!parsed.success) return "invalid_payload";
    const channelId = BigInt(parsed.data.channelId);
    const ch = await getChannel(channelId);
    if (ch.closeAt === 0n) {
      if (!parsed.data.signature) return "signature_required";
      const call = { functionName: "requestCloseWithSig", args: [channelId, parsed.data.signature] } as const;
      return { call, sessionId: ch.sessionId, channelId, action: "close", amount: "0" };
    }
    const refund = (ch.deposit - ch.claimed).toString();
    return { call: { functionName: "finalizeClose", args: [channelId] }, sessionId: ch.sessionId, channelId, action: "finalize", amount: refund };
  }

  async function planApprove(body: unknown): Promise<Planned | string> {
    const parsed = ApproveRequest.safeParse(body);
    if (!parsed.success) return "invalid_payload";
    const taskId = BigInt(parsed.data.taskId);
    const task = await publicClient.readContract({ ...vault, functionName: "getTask", args: [taskId] });
    const call = { functionName: "approveWithSig", args: [taskId, parsed.data.signature] } as const;
    return { call, sessionId: task.sessionId, action: "approve", amount: task.amount.toString() };
  }

  function planDeposit(body: unknown): Planned | string {
    const parsed = DepositRequest.safeParse(body);
    if (!parsed.success) return "invalid_payload";
    const { from, amount, validAfter, validBefore, nonce, signature } = parsed.data;
    let sig;
    try {
      sig = parseSignature(signature);
    } catch {
      return "invalid_signature";
    }
    const v = Number(sig.v ?? 27n + BigInt(sig.yParity));
    const call = { functionName: "depositWithAuthorization", args: [from, BigInt(amount), BigInt(validAfter), BigInt(validBefore), nonce, v, sig.r, sig.s] } as const;
    // No session: deposits share the "0" bucket in the daily limits.
    return { call, sessionId: 0n, action: "deposit", amount, payer: from };
  }

  /** Checks, then sends a legacy tx and reads the ids out of the receipt. Every attempt is recorded. */
  async function execute(planned: Planned | string, ip: string, scheme: string): Promise<SettlementResponse> {
    const c = await check(planned, ip);
    const base = { network, payer: c.payer, amount: c.planned?.amount };
    const record = (ok: boolean, extra: { reason?: string; tx?: string; refId?: string }) =>
      rails.record({
        ip,
        sessionId: c.planned?.sessionId.toString() ?? "unknown",
        scheme,
        action: c.planned?.action ?? "unknown",
        ok,
        amount: c.planned?.amount,
        payer: c.payer,
        ...extra,
      });
    if (!c.ok) {
      record(false, { reason: c.reason });
      return { ...base, success: false, errorReason: c.reason, transaction: "" };
    }

    let hash: `0x${string}`;
    try {
      hash = await walletClient.writeContract({ ...vault, ...c.planned.call, type: "legacy" } as never);
    } catch (err) {
      const reason = reasonOf(err) === "simulation_failed" ? "send_failed" : reasonOf(err);
      record(false, { reason });
      return { ...base, success: false, errorReason: reason, transaction: "" };
    }
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      record(false, { reason: "tx_reverted", tx: hash });
      return { ...base, success: false, errorReason: "tx_reverted", transaction: hash };
    }

    const ids: Pick<SettlementResponse, "receiptId" | "channelId" | "taskId"> = {};
    for (const log of parseEventLogs({ abi: agentVaultAbi, logs: receipt.logs })) {
      const args = log.args as { receiptId?: bigint; channelId?: bigint; taskId?: bigint };
      if (args.receiptId !== undefined) ids.receiptId = args.receiptId.toString();
      if (args.channelId !== undefined) ids.channelId = args.channelId.toString();
      if (args.taskId !== undefined) ids.taskId = args.taskId.toString();
    }
    record(true, { tx: hash, refId: ids.receiptId ?? ids.taskId ?? ids.channelId });
    void warnIfLow();
    return { ...base, success: true, transaction: hash, ...ids };
  }

  async function balance() {
    const wei = await publicClient.getBalance({ address: facilitator });
    return { wei, low: wei < deps.lowBalanceWei };
  }
  async function warnIfLow() {
    const b = await balance().catch(() => undefined);
    if (b?.low) console.warn(`facilitator gas balance low: ${b.wei} wei at ${facilitator}`);
  }

  const app = express();
  app.use(express.json({ limit: "64kb" }));
  const ipOf = (req: Request) => req.ip ?? "unknown";
  const schemeOf = (body: unknown) =>
    (body as { paymentRequirements?: { scheme?: string } })?.paymentRequirements?.scheme ?? "unknown";

  app.get("/supported", (_req, res) => {
    res.json({
      kinds: ["exact", "batch-settlement", "escrow"].map((scheme) => ({
        x402Version: X402_VERSION,
        scheme,
        network,
        extra: { vault: d.AgentVault, asset: d.tUSD8 },
      })),
      extensions: [],
      signers: { "eip155:*": [facilitator] },
    });
  });

  app.post("/verify", async (req, res, next) => {
    try {
      const c = await check(planPayment(req.body), undefined);
      res.json(c.ok ? { isValid: true, payer: c.payer } : { isValid: false, invalidReason: c.reason, payer: c.payer });
    } catch (err) {
      next(err);
    }
  });

  app.post("/settle", async (req, res, next) => {
    try {
      res.json(await serial(() => execute(planPayment(req.body), ipOf(req), schemeOf(req.body))));
    } catch (err) {
      next(err);
    }
  });

  // Option B (D13): sellers never need gas. Claims and closes go through the same checks, limits and queue.
  app.post("/claim", async (req, res, next) => {
    try {
      res.json(await serial(async () => execute(await planClaim(req.body), ipOf(req), "batch-settlement")));
    } catch (err) {
      next(err);
    }
  });

  app.post("/close", async (req, res, next) => {
    try {
      res.json(await serial(async () => execute(await planClose(req.body), ipOf(req), "batch-settlement")));
    } catch (err) {
      next(err);
    }
  });

  // Agents hold no gas, so an agent-approved task release is relayed like a payment.
  app.post("/approve", async (req, res, next) => {
    try {
      res.json(await serial(async () => execute(await planApprove(req.body), ipOf(req), "escrow")));
    } catch (err) {
      next(err);
    }
  });

  // Gasless owner funding (PRD workflow 1): the vault always credits the signer, so relaying it is safe.
  app.post("/deposit", async (req, res, next) => {
    try {
      res.json(await serial(() => execute(planDeposit(req.body), ipOf(req), "deposit")));
    } catch (err) {
      next(err);
    }
  });

  app.get("/activity", async (req, res, next) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 50, 500);
      const b = await balance();
      res.json({ facilitator, balanceWei: b.wei.toString(), lowBalance: b.low, events: rails.recent(limit) });
    } catch (err) {
      next(err);
    }
  });

  return app;
}
export { Rails } from "./rails.js";
