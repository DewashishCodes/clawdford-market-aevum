import { getAddress, isAddress, type Address } from "viem";
import { agentVaultAbi, identityRegistryAbi, mockTUSD8Abi, reputationRegistryAbi, stallRegistryAbi } from "@clawdford/aevum/abis";
import { AgentCard, HEADER_PAYMENT_REQUIRED, PaymentRequired, decodeHeader, networkOf } from "@clawdford/x402";
import { CATEGORIES, MODES, TASK_STATUS } from "../format";
import type { Ctx } from "./ctx";
import type { ChainEvent } from "./indexer";

const arg = <T = bigint>(e: ChainEvent, k: string) => e.args[k] as T;

export interface StallView {
  id: string;
  name: string;
  description?: string;
  usage?: string;
  category: string;
  mode: string;
  unitPrice: string;
  unit: string;
  endpoint: string;
  metadataURI: string;
  owner: Address;
  payee: Address;
  identityId: string;
  domain: string;
  agentCardURI: string;
  stake: string;
  active: boolean;
  rating: { average: number; count: number };
  /** Confirmation of Payee: the agent card names the on-chain payee and lists this stall. */
  cop: "ok" | "mismatch" | "no_card";
}

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[?::1\]?$|\[?f[cd]|\[?fe80)/i;

/**
 * URLs come from chain data or user input, so on Aevum only public https hosts are fetched (no SSRF into our network).
 * shortcut: checks the hostname text, not the resolved IP; resolve and pin the address if this ever runs next to sensitive services.
 */
export function allowedUrl(chainId: number, raw: string): URL | undefined {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
    if (chainId === 44005 && (u.protocol !== "https:" || PRIVATE_HOST.test(u.hostname))) return undefined;
    return u;
  } catch {
    return undefined;
  }
}

// Remote documents (stall metadata, agent cards), cached for a minute.
const docCache = new Map<string, { at: number; doc: Promise<unknown> }>();
function fetchDoc(chainId: number, url: string): Promise<unknown> {
  if (!allowedUrl(chainId, url)) return Promise.resolve(undefined);
  const hit = docCache.get(url);
  if (hit && Date.now() - hit.at < 60_000) return hit.doc;
  const doc = fetch(url, { signal: AbortSignal.timeout(5_000), cache: "no-store", redirect: "error" })
    .then((r) => (r.ok ? r.json() : undefined))
    .catch(() => undefined);
  docCache.set(url, { at: Date.now(), doc });
  return doc;
}

async function metadataOf(chainId: number, uri: string): Promise<{ name?: string; description?: string; usage?: string }> {
  if (!/^https?:\/\//.test(uri)) return {};
  const [url, key] = uri.split("#") as [string, string | undefined];
  const doc = await fetchDoc(chainId, url);
  const entry = Array.isArray(doc) ? doc.find((e) => e?.key === key) : doc;
  return entry && typeof entry === "object" ? (entry as Record<string, string>) : {};
}

async function copOf(chainId: number, cardURI: string, stallId: bigint, payee: Address): Promise<StallView["cop"]> {
  if (!/^https?:\/\//.test(cardURI)) return "no_card";
  const card = AgentCard.safeParse(await fetchDoc(chainId, cardURI));
  if (!card.success) return "no_card";
  return getAddress(card.data.payee) === getAddress(payee) && card.data.stallIds.includes(stallId.toString()) ? "ok" : "mismatch";
}

export async function listStalls(c: Ctx): Promise<StallView[]> {
  const { pub, cfg } = c;
  const d = cfg.deployment;
  const count = await pub.readContract({ address: d.StallRegistry, abi: stallRegistryAbi, functionName: "stallCount" });
  const raw = [];
  for (let offset = 0n; offset < count; offset += 100n) {
    raw.push(...(await pub.readContract({ address: d.StallRegistry, abi: stallRegistryAbi, functionName: "listStalls", args: [offset, 100n] })));
  }
  return Promise.all(raw.map((s, i) => stallView(c, BigInt(i + 1), s)));
}

type RawStall = Awaited<ReturnType<typeof readStall>>;
const readStall = (c: Ctx, id: bigint) => c.pub.readContract({ address: c.cfg.deployment.StallRegistry, abi: stallRegistryAbi, functionName: "getStall", args: [id] });

async function stallView(c: Ctx, id: bigint, s: RawStall): Promise<StallView> {
  const d = c.cfg.deployment;
  const [meta, identity, average, ratingCount] = await Promise.all([
    metadataOf(c.cfg.chainId, s.metadataURI),
    c.pub.readContract({ address: d.IdentityRegistry, abi: identityRegistryAbi, functionName: "getIdentity", args: [s.identityId] }),
    c.pub.readContract({ address: d.ReputationRegistry, abi: reputationRegistryAbi, functionName: "average", args: [id] }),
    c.pub.readContract({ address: d.ReputationRegistry, abi: reputationRegistryAbi, functionName: "count", args: [id] }),
  ]);
  return {
    id: id.toString(),
    name: meta.name ?? `Stall ${id}`,
    description: meta.description,
    usage: meta.usage,
    category: CATEGORIES[s.category] ?? String(s.category),
    mode: MODES[s.mode] ?? String(s.mode),
    unitPrice: s.unitPrice.toString(),
    unit: s.unit,
    endpoint: s.endpoint,
    metadataURI: s.metadataURI,
    owner: s.owner,
    payee: s.payee,
    identityId: s.identityId.toString(),
    domain: identity.domain,
    agentCardURI: identity.agentCardURI,
    stake: s.stake.toString(),
    active: s.active,
    rating: { average: Number(average) / 100, count: Number(ratingCount) },
    cop: await copOf(c.cfg.chainId, identity.agentCardURI, id, s.payee),
  };
}

export interface ReceiptView {
  receiptId: string;
  sessionId: string;
  stallId: string;
  amount: string;
  kind: "exact" | "license" | "stream" | "task";
  txHash: string;
  blockNumber: string;
  time?: number;
}

/** Every payout with a receipt: exact and license (Paid), stream claims (ChannelClaimed), released tasks (TaskReleased). */
function receiptsOf(events: ChainEvent[]): ReceiptView[] {
  const channels = new Map<bigint, ChainEvent>();
  const tasks = new Map<bigint, ChainEvent>();
  const licensed = new Set<bigint>();
  for (const e of events) {
    if (e.name === "ChannelOpened") channels.set(arg(e, "channelId"), e);
    if (e.name === "TaskCreated") tasks.set(arg(e, "taskId"), e);
    if (e.name === "Licensed") licensed.add(arg(e, "receiptId"));
  }
  const out: ReceiptView[] = [];
  const base = (e: ChainEvent) => ({ txHash: e.txHash, blockNumber: e.blockNumber.toString() });
  for (const e of events) {
    if (e.name === "Paid") {
      const id = arg(e, "receiptId");
      out.push({ receiptId: id.toString(), sessionId: arg(e, "sessionId").toString(), stallId: arg(e, "stallId").toString(), amount: arg(e, "amount").toString(), kind: licensed.has(id) ? "license" : "exact", ...base(e) });
    } else if (e.name === "ChannelClaimed") {
      const ch = channels.get(arg(e, "channelId"));
      if (ch) out.push({ receiptId: arg(e, "receiptId").toString(), sessionId: arg(ch, "sessionId").toString(), stallId: arg(ch, "stallId").toString(), amount: arg(e, "amount").toString(), kind: "stream", ...base(e) });
    } else if (e.name === "TaskReleased") {
      const t = tasks.get(arg(e, "taskId"));
      if (t) out.push({ receiptId: arg(e, "receiptId").toString(), sessionId: arg(t, "sessionId").toString(), stallId: arg(t, "stallId").toString(), amount: arg(t, "amount").toString(), kind: "task", ...base(e) });
    }
  }
  return out;
}

async function withTimes<T extends { blockNumber: string; time?: number }>(c: Ctx, rows: T[]) {
  await Promise.all(rows.map(async (r) => (r.time = await c.indexer.timeOf(BigInt(r.blockNumber)))));
  return rows;
}

export async function stats(c: Ctx) {
  const events = await c.indexer.sync();
  const receipts = receiptsOf(events);
  const stalls = await c.pub.readContract({ address: c.cfg.deployment.StallRegistry, abi: stallRegistryAbi, functionName: "stallCount" });
  return {
    stalls: Number(stalls),
    payments: receipts.length,
    settled: receipts.reduce((sum, r) => sum + BigInt(r.amount), 0n).toString(),
    sessions: events.filter((e) => e.name === "SessionCreated").length,
    latest: await withTimes(c, receipts.slice(-8).reverse()),
  };
}

export async function stallDetail(c: Ctx, id: bigint) {
  const count = await c.pub.readContract({ address: c.cfg.deployment.StallRegistry, abi: stallRegistryAbi, functionName: "stallCount" });
  if (id < 1n || id > count) return undefined;
  const [view, events, unstake] = await Promise.all([
    readStall(c, id).then((s) => stallView(c, id, s)),
    c.indexer.sync(),
    c.pub.readContract({ address: c.cfg.deployment.StallRegistry, abi: stallRegistryAbi, functionName: "pendingUnstake", args: [id] }),
  ]);
  const receipts = receiptsOf(events).filter((r) => r.stallId === id.toString());
  const ratings = events
    .filter((e) => e.name === "Rated" && arg(e, "stallId") === id)
    .map((e) => ({ receiptId: arg(e, "receiptId").toString(), score: Number(arg<number>(e, "score")), rater: arg<Address>(e, "rater"), commentURI: arg<string>(e, "commentURI"), txHash: e.txHash }));
  const [amount, unlockAt] = unstake as unknown as [bigint, bigint];
  return { stall: view, receipts: await withTimes(c, receipts.slice(-50).reverse()), ratings: ratings.reverse(), pendingUnstake: { amount: amount.toString(), unlockAt: Number(unlockAt) } };
}

export interface ActivityRow {
  kind: string;
  text: string;
  amount?: string;
  stallId?: string;
  time?: number;
  txHash?: string;
  blockNumber?: string;
  ok: boolean;
}

/** Chain events worth showing plus refusals logged by the facilitator, newest first. */
export async function activity(c: Ctx, limit = 100): Promise<{ rows: ActivityRow[]; facilitator?: { address: string; lowBalance: boolean } }> {
  const events = await c.indexer.sync();
  const channelStall = new Map<bigint, bigint>();
  const taskStall = new Map<bigint, bigint>();
  const rows: ActivityRow[] = [];
  for (const e of events) {
    const at = { txHash: e.txHash, blockNumber: e.blockNumber.toString(), ok: true };
    const s = (k = "stallId") => arg(e, k).toString();
    switch (e.name) {
      case "Paid":
        rows.push({ kind: "payment", text: `Receipt ${arg(e, "receiptId")}: session ${arg(e, "sessionId")} paid stall ${s()}`, amount: arg(e, "amount").toString(), stallId: s(), ...at });
        break;
      case "ChannelOpened":
        channelStall.set(arg(e, "channelId"), arg(e, "stallId"));
        rows.push({ kind: "channel", text: `Channel ${arg(e, "channelId")} opened by session ${arg(e, "sessionId")} with stall ${s()}`, amount: arg(e, "deposit").toString(), stallId: s(), ...at });
        break;
      case "ChannelClaimed":
        rows.push({ kind: "claim", text: `Channel ${arg(e, "channelId")} claim, receipt ${arg(e, "receiptId")}`, amount: arg(e, "amount").toString(), stallId: channelStall.get(arg(e, "channelId"))?.toString(), ...at });
        break;
      case "ChannelFinalized":
        rows.push({ kind: "refund", text: `Channel ${arg(e, "channelId")} closed, unused deposit refunded`, amount: arg(e, "refunded").toString(), ...at });
        break;
      case "TaskCreated":
        taskStall.set(arg(e, "taskId"), arg(e, "stallId"));
        rows.push({ kind: "task", text: `Task ${arg(e, "taskId")} escrowed by session ${arg(e, "sessionId")} for stall ${s()}`, amount: arg(e, "amount").toString(), stallId: s(), ...at });
        break;
      case "TaskSubmitted":
        rows.push({ kind: "task", text: `Task ${arg(e, "taskId")} result submitted`, stallId: taskStall.get(arg(e, "taskId"))?.toString(), ...at });
        break;
      case "TaskReleased":
        rows.push({ kind: "payment", text: `Task ${arg(e, "taskId")} released, receipt ${arg(e, "receiptId")}`, stallId: taskStall.get(arg(e, "taskId"))?.toString(), ...at });
        break;
      case "SessionCreated":
        rows.push({ kind: "session", text: `Session ${arg(e, "sessionId")} created`, ...at });
        break;
      case "SessionRevoked":
        rows.push({ kind: "revoke", text: `Session ${arg(e, "sessionId")} revoked by its owner`, ...at });
        break;
      case "Deposited":
        rows.push({ kind: "deposit", text: `Deposit to the vault${getAddress(arg<Address>(e, "payer")) !== getAddress(arg<Address>(e, "owner")) ? " (gasless)" : ""}`, amount: arg(e, "amount").toString(), ...at });
        break;
      case "StallCreated":
        rows.push({ kind: "stall", text: `Stall ${s()} listed`, stallId: s(), ...at });
        break;
      case "Rated":
        rows.push({ kind: "rating", text: `Receipt ${arg(e, "receiptId")} rated ${arg<number>(e, "score")}/5`, stallId: s(), ...at });
        break;
    }
  }
  const recent = await withTimes(c, rows.slice(-limit) as (ActivityRow & { blockNumber: string })[]);

  let facilitator: { address: string; lowBalance: boolean } | undefined;
  try {
    const f = (await (await fetch(`${c.cfg.facilitatorUrl}/activity?limit=${limit}`, { signal: AbortSignal.timeout(3_000), cache: "no-store" })).json()) as {
      facilitator: string;
      lowBalance: boolean;
      events: { ts: number; ok: boolean; reason?: string; action: string; sessionId: string; amount?: string }[];
    };
    facilitator = { address: f.facilitator, lowBalance: f.lowBalance };
    for (const e of f.events.filter((x) => !x.ok)) {
      rows.push({ kind: "refused", text: `Refused ${e.action} for session ${e.sessionId}: ${e.reason}`, amount: e.amount ?? undefined, time: e.ts, ok: false });
    }
  } catch {
    // facilitator offline: chain events only
  }
  // Newest first; the sort is stable, so chain events sharing a block time keep their reversed chain order.
  const all = [...recent.reverse(), ...rows.filter((r) => r.kind === "refused")];
  return { rows: all.sort((a, b) => (b.time ?? 0) - (a.time ?? 0)).slice(0, limit), facilitator };
}

export async function ownerView(c: Ctx, owner: Address) {
  const d = c.cfg.deployment;
  const vault = { address: d.AgentVault, abi: agentVaultAbi } as const;
  const events = await c.indexer.sync();
  const mine = new Set(events.filter((e) => e.name === "SessionCreated" && getAddress(arg<Address>(e, "owner")) === getAddress(owner)).map((e) => arg(e, "sessionId")));
  const rated = new Set(events.filter((e) => e.name === "Rated").map((e) => arg(e, "receiptId").toString()));

  const sessions = await Promise.all(
    [...mine].map(async (id) => {
      const [s, [today, total]] = await Promise.all([c.pub.readContract({ ...vault, functionName: "getSession", args: [id] }), c.pub.readContract({ ...vault, functionName: "remaining", args: [id] })]);
      const channelIds = events.filter((e) => e.name === "ChannelOpened" && arg(e, "sessionId") === id).map((e) => arg(e, "channelId"));
      const channels = await Promise.all(
        channelIds.map(async (cid) => {
          const ch = await c.pub.readContract({ ...vault, functionName: "getChannel", args: [cid] });
          return { channelId: cid.toString(), stallId: ch.stallId.toString(), deposit: ch.deposit.toString(), claimed: ch.claimed.toString(), closeAt: Number(ch.closeAt), finalized: ch.finalized };
        }),
      );
      const day = BigInt(Math.floor(Date.now() / 86_400_000));
      return {
        sessionId: id.toString(),
        agentKey: s.agentKey,
        perPaymentCap: s.perPaymentCap.toString(),
        dailyCap: s.dailyCap.toString(),
        totalCap: s.totalCap.toString(),
        spentToday: (s.day === day ? s.spentToday : 0n).toString(),
        spentTotal: s.spentTotal.toString(),
        remainingToday: today.toString(),
        remainingTotal: total.toString(),
        expiry: Number(s.expiry),
        categories: CATEGORIES.filter((_, i) => ((s.categoryMask >> i) & 1) === 1),
        revoked: s.revoked,
        agentCanApprove: s.agentCanApprove,
        channels,
      };
    }),
  );
  const receipts = receiptsOf(events)
    .filter((r) => mine.has(BigInt(r.sessionId)))
    .map((r) => ({ ...r, rated: rated.has(r.receiptId) }));
  const [vaultBalance, walletBalance] = await Promise.all([
    c.pub.readContract({ ...vault, functionName: "balanceOf", args: [owner] }),
    c.pub.readContract({ address: d.tUSD8, abi: mockTUSD8Abi, functionName: "balanceOf", args: [owner] }),
  ]);
  return {
    vaultBalance: vaultBalance.toString(),
    walletBalance: walletBalance.toString(),
    sessions: sessions.reverse(),
    receipts: (await withTimes(c, receipts.slice(-30))).reverse(),
    identities: await Promise.all(
      events
        .filter((e) => e.name === "IdentityRegistered" && getAddress(arg<Address>(e, "controller")) === getAddress(owner))
        .map(async (e) => {
          const i = await c.pub.readContract({ address: d.IdentityRegistry, abi: identityRegistryAbi, functionName: "getIdentity", args: [arg(e, "identityId")] });
          return { identityId: arg(e, "identityId").toString(), domain: i.domain, agentCardURI: i.agentCardURI, controller: i.controller };
        }),
    ).then((ids) => ids.filter((i) => getAddress(i.controller) === getAddress(owner))),
  };
}

export async function taskBoard(c: Ctx) {
  const events = await c.indexer.sync();
  const vault = { address: c.cfg.deployment.AgentVault, abi: agentVaultAbi } as const;
  const created = events.filter((e) => e.name === "TaskCreated").slice(-100).reverse();
  return Promise.all(
    created.map(async (e) => {
      const t = await c.pub.readContract({ ...vault, functionName: "getTask", args: [arg(e, "taskId")] });
      return {
        taskId: arg(e, "taskId").toString(),
        sessionId: t.sessionId.toString(),
        stallId: t.stallId.toString(),
        amount: t.amount.toString(),
        status: TASK_STATUS[t.status] ?? String(t.status),
        deadline: Number(t.deadline),
        reviewEnd: Number(t.reviewEnd),
        resultURI: t.resultURI,
      };
    }),
  );
}

/** The `/sell` 402 check: the endpoint must answer 402 with an x402 quote that pays `payee` on this chain, and the agent card must name `payee`. */
export async function checkSeller(c: Ctx, input: { endpoint: string; payee: string; agentCardURI: string; method?: string }) {
  const problems: string[] = [];
  if (!isAddress(input.payee)) return { ok: false, problems: ["payee is not an address"] };
  const payee = getAddress(input.payee);
  const url = allowedUrl(c.cfg.chainId, input.endpoint);
  if (!url) return { ok: false, problems: [c.cfg.chainId === 44005 ? "endpoint must be a public https URL" : "endpoint must be an http(s) URL"] };

  const method = input.method === "POST" ? "POST" : "GET";
  const res = await fetch(url, { method, redirect: "manual", signal: AbortSignal.timeout(8_000), ...(method === "POST" ? { headers: { "content-type": "application/json" }, body: "{}" } : {}) }).catch(() => undefined);
  if (!res) problems.push("endpoint did not answer");
  else if (res.status !== 402) problems.push(`endpoint answered ${res.status}, expected 402 Payment Required (a 400 means it validates input first: try the other method or a request it accepts)`);
  else {
    const header = res.headers.get(HEADER_PAYMENT_REQUIRED);
    if (!header) problems.push(`402 has no ${HEADER_PAYMENT_REQUIRED} header`);
    else {
      try {
        const required = decodeHeader(PaymentRequired, header);
        const option = required.accepts.find((a) => a.network === networkOf(c.cfg.chainId));
        if (!option) problems.push(`no payment option on ${networkOf(c.cfg.chainId)}`);
        else {
          if (getAddress(option.payTo) !== payee) problems.push(`quote pays ${option.payTo}, not the payee ${payee}`);
          if (getAddress(option.extra.vault) !== getAddress(c.cfg.deployment.AgentVault)) problems.push("quote is not for this market's vault");
        }
      } catch {
        problems.push(`${HEADER_PAYMENT_REQUIRED} is not a valid x402 v2 header`);
      }
    }
  }

  if (!/^https?:\/\//.test(input.agentCardURI)) problems.push("agent card URI must be http(s) so buyers can check the payee");
  else {
    const card = AgentCard.safeParse(await fetchDoc(c.cfg.chainId, input.agentCardURI));
    if (!card.success) problems.push("agent card is missing or invalid");
    else if (getAddress(card.data.payee) !== payee) problems.push(`agent card names payee ${card.data.payee}, not ${payee}`);
  }
  return { ok: problems.length === 0, problems };
}
