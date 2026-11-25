import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { agentVaultAbi, identityRegistryAbi, stallRegistryAbi } from "@clawdford/aevum";
import {
  AgentCard,
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_RESPONSE,
  HEADER_PAYMENT_SIGNATURE,
  PaymentRequired,
  SettlementResponse,
  X402_VERSION,
  decodeHeader,
  encodeHeader,
  hashVaultMessage,
  networkOf,
  vaultDomain,
  vaultTypedData,
  type PaymentPayload,
  type PaymentRequirements,
  type VaultPrimaryType,
} from "@clawdford/x402";
import { connect, postJson, type ChainConfig } from "./common.js";

export interface BuyerConfig extends ChainConfig {
  /** The agent's session key. The only key the agent holds. */
  sessionKey: Hex;
  sessionId: bigint;
  /** Most one call may cost, checked before signing. */
  budget: { perCall: bigint };
  /** Deposit for new channels and top ups. Default 0.05 tUSD8 (raised to the stall's minimum). */
  channelDeposit?: bigint;
  /** JSON file that keeps open channels across restarts, so a restarted agent can keep streaming or close and pay its last call. */
  channelFile?: string;
  fetch?: typeof fetch;
}

export type RefusalCode =
  | "PAYEE_MISMATCH"
  | "OVERPRICED"
  | "OVERCHARGED"
  | "SESSION_REVOKED"
  | "SESSION_EXPIRED"
  | "CAP_EXCEEDED"
  | "CATEGORY_NOT_ALLOWED"
  | "STALL_NOT_ALLOWED"
  | "NO_AGENT_CARD"
  | "UNSUPPORTED"
  | "PAYMENT_FAILED";

/** A payment the buyer refused to make, or one the seller, facilitator or vault refused. Nothing was paid. */
export class PaymentRefused extends Error {
  constructor(
    public code: RefusalCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

/** Vault error names and facilitator reason codes to the readable codes agents see (PRD 8.6). */
const REASONS: Record<string, RefusalCode> = {
  PerPaymentCapExceeded: "CAP_EXCEEDED",
  DailyCapExceeded: "CAP_EXCEEDED",
  TotalCapExceeded: "CAP_EXCEEDED",
  InsufficientBalance: "CAP_EXCEEDED",
  RevokedSession: "SESSION_REVOKED",
  SessionExpired: "SESSION_EXPIRED",
  CategoryNotAllowed: "CATEGORY_NOT_ALLOWED",
  StallNotAllowed: "STALL_NOT_ALLOWED",
};
const refusal = (reason: string) => new PaymentRefused(REASONS[reason] ?? "PAYMENT_FAILED", reason);

export interface PaidResult<T = unknown> {
  response: Response;
  data: T;
  /** Decoded PAYMENT-RESPONSE, when the call was paid. */
  receipt?: SettlementResponse;
  /** tUSD8 base units this call cost. */
  spent: bigint;
}

interface Channel {
  channelId: bigint;
  deposit: bigint;
  owed: bigint;
  facilitator: string;
}

const nowSec = () => BigInt(Math.floor(Date.now() / 1000));
const randomNonce = () => BigInt(toHexString(randomBytes(16)));
const toHexString = (b: Buffer) => `0x${b.toString("hex")}`;

function loadChannels(file?: string) {
  const m = new Map<bigint, Channel>();
  if (!file || !existsSync(file)) return m;
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, { channelId: string; deposit: string; owed: string; facilitator: string }>;
  for (const [stallId, c] of Object.entries(raw)) m.set(BigInt(stallId), { channelId: BigInt(c.channelId), deposit: BigInt(c.deposit), owed: BigInt(c.owed), facilitator: c.facilitator });
  return m;
}

function saveChannels(file: string | undefined, channels: Map<bigint, Channel>) {
  if (!file) return;
  mkdirSync(dirname(file), { recursive: true });
  const out = Object.fromEntries([...channels].map(([k, c]) => [k.toString(), { channelId: c.channelId.toString(), deposit: c.deposit.toString(), owed: c.owed.toString(), facilitator: c.facilitator }]));
  writeFileSync(file, JSON.stringify(out, null, 2));
}

export function createBuyer(cfg: BuyerConfig) {
  const { publicClient, deployment: d } = connect(cfg);
  const agent = privateKeyToAccount(cfg.sessionKey);
  const domain = vaultDomain(d.chainId, d.AgentVault);
  const network = networkOf(d.chainId);
  const f = cfg.fetch ?? fetch;
  const channels = loadChannels(cfg.channelFile); // by stall id
  const save = () => saveChannels(cfg.channelFile, channels);
  const sign = (type: VaultPrimaryType, msg: Record<string, string>) => agent.signTypedData(vaultTypedData(domain, type, msg));

  let sessionCache: { at: number; revoked: boolean; expiry: bigint } | undefined;
  async function checkSession() {
    if (!sessionCache || Date.now() - sessionCache.at > 5_000) {
      const s = await publicClient.readContract({ address: d.AgentVault, abi: agentVaultAbi, functionName: "getSession", args: [cfg.sessionId] });
      sessionCache = { at: Date.now(), revoked: s.revoked, expiry: s.expiry };
    }
    if (sessionCache.revoked) throw new PaymentRefused("SESSION_REVOKED", `session ${cfg.sessionId} was revoked by its owner`);
    if (sessionCache.expiry <= nowSec()) throw new PaymentRefused("SESSION_EXPIRED", `session ${cfg.sessionId} has expired`);
  }

  /** Confirmation of Payee and price checks, before anything is signed. The contract stays the real guard. */
  async function guard(a: PaymentRequirements) {
    await checkSession();
    const stallId = BigInt(a.extra.stallId);
    const stall = await publicClient.readContract({ address: d.StallRegistry, abi: stallRegistryAbi, functionName: "getStall", args: [stallId] });
    const identity = await publicClient.readContract({ address: d.IdentityRegistry, abi: identityRegistryAbi, functionName: "getIdentity", args: [stall.identityId] });

    if (!/^https?:\/\//.test(identity.agentCardURI)) throw new PaymentRefused("NO_AGENT_CARD", `stall ${stallId} has no fetchable agent card`);
    let card: AgentCard;
    try {
      card = AgentCard.parse(await (await f(identity.agentCardURI)).json());
    } catch {
      throw new PaymentRefused("NO_AGENT_CARD", `agent card at ${identity.agentCardURI} is missing or invalid`);
    }
    const quoted = getAddress(a.payTo);
    if (quoted !== getAddress(stall.payee) || quoted !== getAddress(card.payee) || !card.stallIds.includes(stallId.toString())) {
      throw new PaymentRefused("PAYEE_MISMATCH", `quote pays ${quoted}, stall ${stallId} is registered to ${stall.payee}, agent card says ${card.payee}`);
    }

    const price = BigInt(a.amount); // per unit for streams
    if (price > stall.unitPrice) throw new PaymentRefused("OVERPRICED", `asks ${price}, on-chain price is ${stall.unitPrice} per ${stall.unit}`);
    const cost = a.scheme === "batch-settlement" ? BigInt(a.extra.maxAmount) : price;
    if (cost > cfg.budget.perCall) throw new PaymentRefused("OVERPRICED", `call may cost ${cost}, budget per call is ${cfg.budget.perCall}`);
  }

  async function relay(facilitator: string | undefined, a: PaymentRequirements, payload: unknown) {
    if (!facilitator) throw new PaymentRefused("UNSUPPORTED", "stall names no facilitator");
    const req = { x402Version: X402_VERSION, paymentPayload: { x402Version: X402_VERSION, accepted: a, payload }, paymentRequirements: a };
    const s = await postJson<SettlementResponse>(`${facilitator}/settle`, req, f);
    if (!s.success) throw refusal(s.errorReason ?? "settle_failed");
    return s;
  }

  /** On-chain state of a saved channel, or undefined when it is not this session's channel with that stall (e.g. a file left from a reset chain). */
  async function channelState(stallId: bigint, ch: Channel) {
    const s = await publicClient.readContract({ address: d.AgentVault, abi: agentVaultAbi, functionName: "getChannel", args: [ch.channelId] });
    return s.sessionId === cfg.sessionId && s.stallId === stallId ? s : undefined;
  }

  /** Opens a channel or tops it up so the next request fits; returns the voucher payload. */
  async function streamPayload(a: Extract<PaymentRequirements, { scheme: "batch-settlement" }>) {
    const stallId = BigInt(a.extra.stallId);
    const maxAmount = BigInt(a.extra.maxAmount);
    let deposit = cfg.channelDeposit ?? 50_000n;
    if (deposit < BigInt(a.extra.minDeposit)) deposit = BigInt(a.extra.minDeposit);
    if (deposit < maxAmount) deposit = maxAmount;
    const validBefore = (nowSec() + 300n).toString();

    let ch = channels.get(stallId);
    if (ch && (await channelState(stallId, ch))?.closeAt !== 0n) {
      // Stale, or closed meanwhile (the owner can close an orphaned channel from the web app): open a fresh one.
      channels.delete(stallId);
      ch = undefined;
    }
    if (!ch) {
      const open = { sessionId: cfg.sessionId.toString(), stallId: stallId.toString(), deposit: deposit.toString(), validBefore, nonce: randomNonce().toString() };
      const s = await relay(a.extra.facilitator, a, { action: "open", open, signature: await sign("OpenChannel", open) });
      ch = { channelId: BigInt(s.channelId!), deposit, owed: 0n, facilitator: a.extra.facilitator! };
      channels.set(stallId, ch);
      save();
    } else if (ch.deposit - ch.owed < maxAmount) {
      const topUp = { channelId: ch.channelId.toString(), amount: deposit.toString(), validBefore, nonce: randomNonce().toString() };
      await relay(a.extra.facilitator, a, { action: "topUp", topUp, signature: await sign("TopUp", topUp) });
      ch.deposit += deposit;
      save();
    }
    const voucher = { channelId: ch.channelId.toString(), cumulativeAmount: ch.owed.toString() };
    return { action: "voucher", voucher, signature: await sign("Voucher", voucher) } as const;
  }

  async function payloadFor(a: PaymentRequirements): Promise<unknown> {
    const validBefore = (nowSec() + BigInt(Math.min(a.maxTimeoutSeconds, 300))).toString();
    if (a.scheme === "exact") {
      const intent = { quoteHash: hashVaultMessage(domain, "Quote", a.extra.quote), sessionId: cfg.sessionId.toString(), validBefore, nonce: randomNonce().toString() };
      return { intent, signature: await sign("PaymentIntent", intent) };
    }
    if (a.scheme === "escrow") {
      if (!a.extra.specHash) throw new PaymentRefused("UNSUPPORTED", "task quote has no specHash");
      const deadline = (nowSec() + BigInt(a.extra.deadlineSeconds ?? 3600)).toString();
      const task = { sessionId: cfg.sessionId.toString(), stallId: a.extra.stallId, amount: a.amount, specHash: a.extra.specHash, deadline, validBefore, nonce: randomNonce().toString() };
      return { task, signature: await sign("CreateTask", task) };
    }
    return streamPayload(a);
  }

  const readBody = async (res: Response) =>
    (res.headers.get("content-type") ?? "").includes("json") ? res.json() : res.text();

  /** fetch that pays 402s from the session: picks an option, runs the guards, signs, retries once. */
  async function payingFetch<T = unknown>(url: string, init?: RequestInit): Promise<PaidResult<T>> {
    const first = await f(url, init);
    if (first.status !== 402) return { response: first, data: (await readBody(first)) as T, spent: 0n };

    const header = first.headers.get(HEADER_PAYMENT_REQUIRED);
    if (!header) throw new PaymentRefused("UNSUPPORTED", "402 without a PAYMENT-REQUIRED header");
    const required = decodeHeader(PaymentRequired, header);
    const a = required.accepts.find((x) => x.network === network && getAddress(x.extra.vault) === getAddress(d.AgentVault));
    if (!a) throw new PaymentRefused("UNSUPPORTED", `no option on ${network} through vault ${d.AgentVault}`);
    await guard(a);

    const payload = { x402Version: X402_VERSION, accepted: a, payload: await payloadFor(a) } as PaymentPayload;
    const res = await f(url, { ...init, headers: { ...(init?.headers as Record<string, string>), [HEADER_PAYMENT_SIGNATURE]: encodeHeader(payload) } });
    if (res.status === 402) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw refusal(body.error ?? "payment_rejected");
    }
    const rh = res.headers.get(HEADER_PAYMENT_RESPONSE);
    const receipt = rh ? decodeHeader(SettlementResponse, rh) : undefined;

    let spent = BigInt(a.amount);
    if (a.scheme === "batch-settlement") {
      const ch = channels.get(BigInt(a.extra.stallId))!;
      const owed = BigInt(receipt?.owed ?? ch.owed);
      spent = owed - ch.owed;
      if (spent < 0n || spent > BigInt(a.extra.maxAmount)) {
        throw new PaymentRefused("OVERCHARGED", `seller metered ${spent}, quoted at most ${a.extra.maxAmount}`);
      }
      ch.owed = owed;
      save();
    }
    return { response: res, data: (await readBody(res)) as T, receipt, spent };
  }

  /**
   * Closes the channel with a stall: starts the close window, then pays the last metered call with a final voucher.
   * The seller's settler finalizes after the window and the unused deposit returns to the owner.
   */
  async function closeChannel(stallId: bigint) {
    const ch = channels.get(stallId);
    if (!ch) return false;
    const state = await channelState(stallId, ch);
    if (!state) {
      channels.delete(stallId);
      save();
      return false;
    }
    if (state.closeAt === 0n) {
      const closed = await postJson<SettlementResponse>(`${ch.facilitator}/close`, { channelId: ch.channelId.toString(), signature: await sign("CloseChannel", { channelId: ch.channelId.toString() }) }, f);
      if (!closed.success) throw refusal(closed.errorReason ?? "close_failed");
    }
    if (ch.owed > state.claimed && !state.finalized) {
      const voucher = { channelId: ch.channelId.toString(), cumulativeAmount: ch.owed.toString() };
      // Fails harmlessly if the seller already claimed this much.
      await postJson(`${ch.facilitator}/claim`, { voucher, signature: await sign("Voucher", voucher) }, f);
    }
    channels.delete(stallId);
    save();
    return true;
  }

  /** Releases a submitted task's escrow to the seller, gaslessly through the facilitator. Needs `agentCanApprove`. */
  async function approveTask(taskId: bigint, facilitatorUrl: string) {
    await checkSession();
    const r = await postJson<SettlementResponse>(`${facilitatorUrl}/approve`, { taskId: taskId.toString(), signature: await sign("ApproveTask", { taskId: taskId.toString() }) }, f);
    if (!r.success) throw refusal(r.errorReason ?? "approve_failed");
    return r;
  }

  return { payingFetch, closeChannel, approveTask, address: agent.address as Address, channels };
}

export type Buyer = ReturnType<typeof createBuyer>;
