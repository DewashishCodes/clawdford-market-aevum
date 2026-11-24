import express, { type Request } from "express";
import {
  BaseError,
  ContractFunctionRevertedError,
  parseEventLogs,
  type Account,
  type Address,
  type Chain,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { agentVaultAbi, type Deployment } from "@clawdford/aevum";
import { FacilitatorRequest, X402_VERSION, networkOf, type SettlementResponse } from "@clawdford/x402";
import { plan, type Planned } from "./vault.js";
import type { Rails } from "./rails.js";

export interface FacilitatorDeps {
  publicClient: PublicClient;
  walletClient: WalletClient<Transport, Chain, Account>;
  deployment: Deployment;
  rails: Rails;
  /** Warn (and flag in /activity) when the gas wallet drops below this many wei. */
  lowBalanceWei: bigint;
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

  // One settle at a time: keeps our own tx nonces in order and stops two relays of one signed message racing.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>) => {
    const run = queue.then(fn);
    queue = run.catch(() => undefined);
    return run;
  };

  async function check(body: unknown, ip: string | undefined): Promise<Checked> {
    const parsed = FacilitatorRequest.safeParse(body);
    if (!parsed.success) return { ok: false, reason: "invalid_payload" };
    const planned = plan(parsed.data, d);
    if (typeof planned === "string") return { ok: false, reason: planned };

    if (planned.channelId !== undefined) {
      const ch = await publicClient.readContract({ ...vault, functionName: "getChannel", args: [planned.channelId] });
      planned.sessionId = ch.sessionId;
    }
    const session = await publicClient.readContract({ ...vault, functionName: "getSession", args: [planned.sessionId] });
    const payer = session.owner;
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

  async function settle(body: unknown, ip: string): Promise<SettlementResponse> {
    const c = await check(body, ip);
    const base = { network, payer: c.payer, amount: c.planned?.amount };
    const record = (ok: boolean, extra: { reason?: string; tx?: string; refId?: string }) =>
      rails.record({
        ip,
        sessionId: c.planned?.sessionId.toString() ?? "unknown",
        scheme: (body as { paymentRequirements?: { scheme?: string } })?.paymentRequirements?.scheme ?? "unknown",
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
      if (log.eventName === "Paid") ids.receiptId = log.args.receiptId.toString();
      if (log.eventName === "ChannelOpened" || log.eventName === "ChannelToppedUp") ids.channelId = log.args.channelId.toString();
      if (log.eventName === "TaskCreated") ids.taskId = log.args.taskId.toString();
    }
    record(true, { tx: hash, refId: ids.receiptId ?? ids.channelId ?? ids.taskId });
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
      const c = await check(req.body, undefined);
      res.json(c.ok ? { isValid: true, payer: c.payer } : { isValid: false, invalidReason: c.reason, payer: c.payer });
    } catch (err) {
      next(err);
    }
  });

  app.post("/settle", async (req, res, next) => {
    try {
      res.json(await serial(() => settle(req.body, ipOf(req))));
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
