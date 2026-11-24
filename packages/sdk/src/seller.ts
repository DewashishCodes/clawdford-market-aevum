import { randomBytes } from "node:crypto";
import type { Request, RequestHandler, Response } from "express";
import { createWalletClient, keccak256, recoverTypedDataAddress, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { agentVaultAbi, stallRegistryAbi } from "@clawdford/aevum";
import {
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_RESPONSE,
  HEADER_PAYMENT_SIGNATURE,
  PaymentPayload,
  X402_VERSION,
  decodeHeader,
  encodeHeader,
  networkOf,
  vaultDomain,
  vaultTypedData,
  type AgentCard,
  type PaymentRequirements,
  type SettlementResponse,
} from "@clawdford/x402";
import { connect, postJson, type ChainConfig } from "./common.js";
import { VoucherStore } from "./voucher-store.js";

export interface SellerConfig extends ChainConfig {
  stallId: bigint;
  /** Signs quotes; must be the stall's registered quoteSigner. */
  quoteKey: Hex;
  facilitatorUrl: string;
  /** Stall owner or payee key, only needed for `submitResult` (task mode). */
  ownerKey?: Hex;
  /** Voucher store path. Default `seller-<stallId>.sqlite`. */
  dbPath?: string;
  quoteTtlSeconds?: number;
  /** The settler claims an open channel once this much is unclaimed (closing channels always). Default 0.01 tUSD8. */
  claimThreshold?: bigint;
}

type Units = (req: Request, res: Response) => bigint | number;

export type PaidOptions = { description?: string } & (
  | { mode: "exact" | "license"; price: bigint }
  | { mode: "stream"; unitPrice: bigint; unit: string; maxUnits: (req: Request) => bigint | number; meter: Units; minDeposit?: bigint }
  | { mode: "task"; price: bigint; deadlineSeconds?: number }
);

/** Payment details for the handler, at `res.locals.payment`. */
export type PaymentLocals = SettlementResponse;

const resourceHash = (req: Request) => keccak256(toHex(`${req.method} ${req.originalUrl}`));
const specHashOf = (req: Request) => keccak256(toHex(`${req.method} ${req.originalUrl} ${JSON.stringify(req.body ?? null)}`));
const now = () => BigInt(Math.floor(Date.now() / 1000));

/** Serves a static agent card. Register its URL as the identity's agentCardURI. */
export function serveAgentCard(card: AgentCard): RequestHandler {
  return (_req, res) => {
    res.json(card);
  };
}

export function createSeller(cfg: SellerConfig) {
  const { publicClient, chain, transport, deployment: d } = connect(cfg);
  const quoter = privateKeyToAccount(cfg.quoteKey);
  const domain = vaultDomain(d.chainId, d.AgentVault);
  const network = networkOf(d.chainId);
  const store = new VoucherStore(cfg.dbPath ?? `seller-${cfg.stallId}.sqlite`);
  const vault = { abi: agentVaultAbi, address: d.AgentVault } as const;
  const busy = new Set<bigint>(); // one in-flight request per channel keeps metering simple

  // shortcut: payee read once per process; restart the seller after changing the stall payee.
  let payee: Promise<Address> | undefined;
  const payTo = () =>
    (payee ??= publicClient
      .readContract({ address: d.StallRegistry, abi: stallRegistryAbi, functionName: "paymentInfo", args: [cfg.stallId] })
      .then((i) => i.payee));

  async function requirements(req: Request, o: PaidOptions): Promise<PaymentRequirements> {
    const common = { network, asset: d.tUSD8, payTo: await payTo(), maxTimeoutSeconds: cfg.quoteTtlSeconds ?? 300 };
    const extra = { vault: d.AgentVault, stallId: cfg.stallId.toString(), facilitator: cfg.facilitatorUrl };
    if (o.mode === "stream") {
      const maxAmount = BigInt(o.maxUnits(req)) * o.unitPrice;
      const minDeposit = o.minDeposit ?? maxAmount * 4n;
      return { scheme: "batch-settlement", ...common, amount: o.unitPrice.toString(), extra: { ...extra, unit: o.unit, minDeposit: minDeposit.toString(), maxAmount: maxAmount.toString() } };
    }
    if (o.mode === "task") {
      return { scheme: "escrow", ...common, amount: o.price.toString(), extra: { ...extra, specHash: specHashOf(req), deadlineSeconds: o.deadlineSeconds ?? 3600 } };
    }
    const quote = {
      stallId: cfg.stallId.toString(),
      amount: o.price.toString(),
      resourceHash: resourceHash(req),
      buyerSession: "0",
      validBefore: (now() + BigInt(common.maxTimeoutSeconds)).toString(),
      quoteNonce: toHex(randomBytes(32)),
    };
    const quoteSig = await quoter.signTypedData(vaultTypedData(domain, "Quote", quote));
    return { scheme: "exact", ...common, amount: o.price.toString(), extra: { ...extra, quote, quoteSig } };
  }

  async function send402(req: Request, res: Response, o: PaidOptions, error?: string, body: object = {}) {
    const accepts = [await requirements(req, o)];
    const resource = { url: `${req.protocol}://${req.get("host")}${req.originalUrl}`, description: o.description };
    res.status(402).set(HEADER_PAYMENT_REQUIRED, encodeHeader({ x402Version: X402_VERSION, error, resource, accepts })).json({ error, ...body });
  }

  const settle = (payload: PaymentPayload) =>
    postJson<SettlementResponse>(`${cfg.facilitatorUrl}/settle`, { x402Version: X402_VERSION, paymentPayload: payload, paymentRequirements: payload.accepted });

  /** Express middleware: answers 402 until the request carries a valid payment, then runs the handler. */
  function paid(o: PaidOptions): RequestHandler {
    return async (req, res, next) => {
      try {
        const header = req.get(HEADER_PAYMENT_SIGNATURE);
        if (!header) return await send402(req, res, o);
        let p: PaymentPayload;
        try {
          p = decodeHeader(PaymentPayload, header);
        } catch {
          return await send402(req, res, o, "invalid_payment");
        }
        if (p.accepted.extra.stallId !== cfg.stallId.toString()) return await send402(req, res, o, "wrong_stall");

        if (o.mode === "stream") return await stream(req, res, next, o, p);

        if (o.mode === "task") {
          if (p.accepted.scheme !== "escrow") return await send402(req, res, o, "wrong_scheme");
          const { task } = (p as Extract<PaymentPayload, { accepted: { scheme: "escrow" } }>).payload;
          if (task.amount !== o.price.toString() || task.specHash !== specHashOf(req)) return await send402(req, res, o, "task_mismatch");
        } else {
          if (p.accepted.scheme !== "exact") return await send402(req, res, o, "wrong_scheme");
          // The contract checks our signature; we check the quote is for this resource at this price.
          const { quote } = p.accepted.extra;
          if (quote.amount !== o.price.toString() || quote.resourceHash !== resourceHash(req)) return await send402(req, res, o, "quote_mismatch");
        }
        const s = await settle(p);
        if (!s.success) return await send402(req, res, o, s.errorReason ?? "settle_failed");
        res.set(HEADER_PAYMENT_RESPONSE, encodeHeader(s));
        res.locals.payment = s satisfies PaymentLocals;
        next();
      } catch (err) {
        next(err);
      }
    };
  }

  /** Pay as you go: each request carries a voucher for everything served so far (D12). */
  async function stream(req: Request, res: Response, next: (err?: unknown) => void, o: Extract<PaidOptions, { mode: "stream" }>, p: PaymentPayload) {
    if (p.accepted.scheme !== "batch-settlement") return send402(req, res, o, "wrong_scheme");
    const pl = (p as Extract<PaymentPayload, { accepted: { scheme: "batch-settlement" } }>).payload;
    if (pl.action !== "voucher") return send402(req, res, o, "voucher_required");
    const channelId = BigInt(pl.voucher.channelId);
    const cumulative = BigInt(pl.voucher.cumulativeAmount);

    const ch = await publicClient.readContract({ ...vault, functionName: "getChannel", args: [channelId] });
    if (ch.stallId !== cfg.stallId) return send402(req, res, o, "wrong_stall");
    if (ch.closeAt !== 0n || ch.finalized) return send402(req, res, o, "channel_closing");
    const session = await publicClient.readContract({ ...vault, functionName: "getSession", args: [ch.sessionId] });
    const signer = await recoverTypedDataAddress({ ...vaultTypedData(domain, "Voucher", pl.voucher), signature: pl.signature });
    if (signer !== session.agentKey) return send402(req, res, o, "bad_voucher_signature");

    const state = store.get(channelId);
    const owed = { owed: state.spent.toString(), channelId: channelId.toString() };
    if (cumulative < state.spent) return send402(req, res, o, "voucher_too_low", owed);
    if (cumulative > ch.deposit) return send402(req, res, o, "voucher_too_large", owed);
    const maxCost = BigInt(o.maxUnits(req)) * o.unitPrice;
    if (ch.deposit - state.spent < maxCost) return send402(req, res, o, "insufficient_deposit", owed);
    if (busy.has(channelId)) return void res.status(409).json({ error: "channel_busy" });

    store.saveVoucher(channelId, cumulative, pl.signature);
    busy.add(channelId);
    res.on("close", () => busy.delete(channelId));

    // Meter when the handler writes its headers, so the cost can go in PAYMENT-RESPONSE.
    const writeHead = res.writeHead.bind(res) as (...a: unknown[]) => Response;
    let metered = false;
    res.writeHead = ((...args: unknown[]) => {
      if (!metered) {
        metered = true;
        const units = res.statusCode < 400 ? BigInt(o.meter(req, res)) : 0n;
        const cost = units * o.unitPrice > maxCost ? maxCost : units * o.unitPrice;
        const spent = store.get(channelId).spent + cost;
        store.setSpent(channelId, spent);
        const s: SettlementResponse = { success: true, transaction: "", network, channelId: channelId.toString(), amount: cost.toString(), owed: spent.toString() };
        res.setHeader(HEADER_PAYMENT_RESPONSE, encodeHeader(s));
        res.locals.payment = s;
      }
      return writeHead(...args);
    }) as typeof res.writeHead;
    next();
  }

  /**
   * One settler pass: claim the best voucher of each channel when enough is unclaimed or the channel is closing,
   * and finalize closed channels after the window so the buyer gets the rest back. The facilitator pays the gas.
   */
  async function settleNow() {
    const results: SettlementResponse[] = [];
    for (const st of store.open()) {
      const ch = await publicClient.readContract({ ...vault, functionName: "getChannel", args: [st.channelId] });
      if (ch.finalized) {
        store.markDone(st.channelId);
        continue;
      }
      const unclaimed = st.best > ch.claimed ? st.best - ch.claimed : 0n;
      if (unclaimed > 0n && st.sig && (ch.closeAt !== 0n || unclaimed >= (cfg.claimThreshold ?? 10_000n))) {
        const voucher = { channelId: st.channelId.toString(), cumulativeAmount: st.best.toString() };
        results.push(await postJson<SettlementResponse>(`${cfg.facilitatorUrl}/claim`, { voucher, signature: st.sig }));
      } else if (ch.closeAt !== 0n && (await publicClient.getBlock()).timestamp >= ch.closeAt) {
        const r = await postJson<SettlementResponse>(`${cfg.facilitatorUrl}/close`, { channelId: st.channelId.toString() });
        if (r.success) store.markDone(st.channelId);
        results.push(r);
      }
    }
    return results;
  }

  /** Runs `settleNow` every `intervalMs`. Returns a stop function. */
  function startSettler(intervalMs = 30_000) {
    let running = false;
    const timer = setInterval(async () => {
      if (running) return;
      running = true;
      await settleNow().catch((err) => console.warn("settler:", err));
      running = false;
    }, intervalMs);
    return () => clearInterval(timer);
  }

  /** Task mode: deliver a result (sent from the stall owner or payee key, which pays its own gas). */
  async function submitResult(taskId: bigint, result: string, resultURI: string) {
    if (!cfg.ownerKey) throw new Error("submitResult needs ownerKey");
    const wallet = createWalletClient({ chain, transport, account: privateKeyToAccount(cfg.ownerKey) });
    const hash = await wallet.writeContract({ ...vault, functionName: "submitResult", args: [taskId, keccak256(toHex(result)), resultURI], type: "legacy" });
    const r = await publicClient.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error("submitResult reverted");
    return hash;
  }

  return { paid, settleNow, startSettler, submitResult, store };
}

export type Seller = ReturnType<typeof createSeller>;
