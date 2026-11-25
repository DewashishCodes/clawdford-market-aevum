import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createPublicClient, createWalletClient, formatUnits, http, keccak256, parseUnits, toHex, zeroAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import { agentVaultAbi, chainById, loadDeployment, reputationRegistryAbi, stallRegistryAbi, type Deployment } from "@clawdford/aevum";
import { createBuyer, PaymentRefused } from "@clawdford/sdk/buyer";

export interface MarketConfig {
  chainId: number;
  rpcUrl?: string;
  deployment?: Deployment;
  /** The agent's session key: the only key this server holds. */
  sessionKey: Hex;
  sessionId: bigint;
  /** Most one call may cost (tUSD8 base units), checked before signing. */
  perCallBudget: bigint;
  /** Deposit for stream channels. */
  channelDeposit?: bigint;
  /** Relays gasless task approvals. */
  facilitatorUrl: string;
  /** Where download_skill installs skills (`<dir>/<name>/SKILL.md`). */
  skillsDir: string;
  /** Keeps open stream channels across restarts (see BuyerConfig.channelFile). */
  channelFile?: string;
}

const CATEGORIES = ["inference", "data", "tool", "knowledge", "skill", "weights", "compute", "human", "eval", "outcome"] as const;
const MODES = ["exact", "stream", "task", "license"] as const;
const TASK_STATUS = ["none", "open", "submitted", "disputed", "released", "refunded", "resolved"] as const;
const TOOL_FOR_MODE = { exact: "call_service", stream: "call_service", task: "create_task", license: "buy_license or download_skill" } as const;

const tusd = (x: bigint) => `${formatUnits(x, 6)} tUSD8`;
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

type Json = Record<string, unknown>;
/** Thrown for tool misuse the agent can fix (wrong mode, unknown stall). */
class ToolError extends Error {}

/** The market tools, as plain async functions (the MCP server below wraps them). */
export function createMarketTools(cfg: MarketConfig) {
  const base = chainById(cfg.chainId);
  const rpc = cfg.rpcUrl ?? base.rpcUrls.default.http[0];
  const chain = { ...base, rpcUrls: { default: { http: [rpc] } } };
  const pub = createPublicClient({ chain, transport: http(rpc) });
  const d = cfg.deployment ?? loadDeployment(cfg.chainId);
  const agent = privateKeyToAccount(cfg.sessionKey);
  const buyer = createBuyer({ chainId: cfg.chainId, rpcUrl: rpc, deployment: d, sessionKey: cfg.sessionKey, sessionId: cfg.sessionId, budget: { perCall: cfg.perCallBudget }, channelDeposit: cfg.channelDeposit, channelFile: cfg.channelFile });
  const vault = { address: d.AgentVault, abi: agentVaultAbi } as const;

  const session = () => pub.readContract({ ...vault, functionName: "getSession", args: [cfg.sessionId] });

  /** Appended to every tool result so the agent can reason about its budget. */
  async function budget() {
    const [s, [today, total]] = await Promise.all([session(), pub.readContract({ ...vault, functionName: "remaining", args: [cfg.sessionId] })]);
    const day = BigInt(Math.floor(Date.now() / 86_400_000));
    return { spentToday: tusd(s.day === day ? s.spentToday : 0n), spentTotal: tusd(s.spentTotal), remainingToday: tusd(today), remainingTotal: tusd(total) };
  }

  async function stall(stallId: bigint) {
    const count = await pub.readContract({ address: d.StallRegistry, abi: stallRegistryAbi, functionName: "stallCount" });
    if (stallId < 1n || stallId > count) throw new ToolError(`unknown stall ${stallId}; use market_search to find stall ids`);
    const s = await pub.readContract({ address: d.StallRegistry, abi: stallRegistryAbi, functionName: "getStall", args: [stallId] });
    return { ...s, mode: MODES[s.mode] ?? "exact" };
  }

  // Stall metadata (name, description, usage) from its metadataURI, e.g. `https://host/catalog#lexmodel`.
  const metaCache = new Map<string, Promise<unknown>>();
  async function metadata(uri: string): Promise<Json> {
    if (!/^https?:\/\//.test(uri)) return {};
    const [url, key] = uri.split("#") as [string, string | undefined];
    if (!metaCache.has(url)) metaCache.set(url, fetch(url, { signal: AbortSignal.timeout(5_000) }).then((r) => r.json()).catch(() => undefined));
    const doc = await metaCache.get(url);
    if (Array.isArray(doc)) return (doc.find((e) => e?.key === key) as Json) ?? {};
    return doc && typeof doc === "object" ? (doc as Json) : {};
  }

  async function market_search(a: { query?: string; category?: string; mode?: string; maxPrice?: string }) {
    const count = await pub.readContract({ address: d.StallRegistry, abi: stallRegistryAbi, functionName: "stallCount" });
    const all = [];
    for (let offset = 0n; offset < count; offset += 100n) {
      all.push(...(await pub.readContract({ address: d.StallRegistry, abi: stallRegistryAbi, functionName: "listStalls", args: [offset, 100n] })));
    }
    const mask = (await session()).categoryMask;
    const words = (a.query ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? [];
    const maxPrice = a.maxPrice ? parseUnits(a.maxPrice, 6) : undefined;
    const out = [];
    for (const [i, s] of all.entries()) {
      const id = BigInt(i + 1);
      const category = CATEGORIES[s.category] ?? String(s.category);
      const mode = MODES[s.mode] ?? "exact";
      if (!s.active || (a.category && category !== a.category) || (a.mode && mode !== a.mode) || (maxPrice !== undefined && s.unitPrice > maxPrice)) continue;
      const m = await metadata(s.metadataURI);
      const text = `${m.name ?? ""} ${m.description ?? ""} ${category} ${s.unit}`.toLowerCase();
      const score = words.filter((w) => text.includes(w)).length;
      if (words.length && score === 0) continue;
      const [avg, n] = await Promise.all([
        pub.readContract({ address: d.ReputationRegistry, abi: reputationRegistryAbi, functionName: "average", args: [id] }),
        pub.readContract({ address: d.ReputationRegistry, abi: reputationRegistryAbi, functionName: "count", args: [id] }),
      ]);
      out.push({
        score,
        stall: {
          stallId: id.toString(),
          name: m.name ?? `Stall ${id}`,
          description: m.description,
          category,
          mode,
          price: `${tusd(s.unitPrice)} per ${s.unit}`,
          usage: m.usage,
          callWith: TOOL_FOR_MODE[mode],
          allowedBySession: ((mask >> s.category) & 1) === 1,
          rating: n === 0n ? "unrated" : `${(Number(avg) / 100).toFixed(2)} / 5 from ${n}`,
          endpoint: s.endpoint,
        },
      });
    }
    out.sort((x, y) => y.score - x.score);
    return { stalls: out.map((o) => o.stall), note: "Agent cards and prices are checked again before every payment." };
  }

  async function wallet_status() {
    const s = await session();
    if (s.owner === zeroAddress) throw new ToolError(`session ${cfg.sessionId} does not exist on chain ${cfg.chainId}; check SESSION_ID and CHAIN_ID`);
    const now = BigInt(Math.floor(Date.now() / 1000));
    return {
      sessionId: cfg.sessionId.toString(),
      agent: agent.address,
      revoked: s.revoked,
      expired: s.expiry <= now,
      expiresAt: new Date(Number(s.expiry) * 1000).toISOString(),
      caps: { perPayment: tusd(s.perPaymentCap), daily: tusd(s.dailyCap), total: tusd(s.totalCap) },
      allowedCategories: CATEGORIES.filter((_, i) => ((s.categoryMask >> i) & 1) === 1),
      agentCanApprove: s.agentCanApprove,
      ownerVaultBalance: tusd(await pub.readContract({ ...vault, functionName: "balanceOf", args: [s.owner] })),
      openChannels: [...buyer.channels.entries()].map(([stallId, ch]) => ({ stallId: stallId.toString(), channelId: ch.channelId.toString(), deposit: tusd(ch.deposit), owed: tusd(ch.owed) })),
    };
  }

  function urlOf(endpoint: string, query?: Record<string, string | number | boolean>) {
    const u = new URL(endpoint);
    for (const [k, v] of Object.entries(query ?? {})) u.searchParams.set(k, String(v));
    return u.toString();
  }

  /** Pays only the stall's own registered endpoint, never an arbitrary URL. */
  async function pay(stallId: bigint, method: string, query?: Record<string, string | number | boolean>, body?: unknown) {
    const s = await stall(stallId);
    const init: RequestInit = { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) };
    const r = await buyer.payingFetch(urlOf(s.endpoint, query), init);
    return { s, r, paid: { cost: tusd(r.spent), receiptId: r.receipt?.receiptId, channelId: r.receipt?.channelId, transaction: r.receipt?.transaction || undefined } };
  }

  async function call_service(a: { stallId: string; method?: "GET" | "POST"; query?: Record<string, string | number | boolean>; body?: unknown }) {
    const s = await stall(BigInt(a.stallId));
    if (s.mode !== "exact" && s.mode !== "stream") throw new ToolError(`stall ${a.stallId} is a ${s.mode} stall; use ${TOOL_FOR_MODE[s.mode]}`);
    const { r, paid } = await pay(BigInt(a.stallId), a.method ?? (a.body === undefined ? "GET" : "POST"), a.query, a.body);
    if (!r.response.ok) return { status: r.response.status, error: r.data, ...paid };
    return { result: r.data, ...paid, ...(s.mode === "stream" ? { note: "Streamed calls draw from an open channel; close_channels returns the unused deposit." } : {}) };
  }

  async function buyLicense(stallId: string) {
    const s = await stall(BigInt(stallId));
    if (s.mode !== "license") throw new ToolError(`stall ${stallId} is a ${s.mode} stall; use ${TOOL_FOR_MODE[s.mode]}`);
    const { r, paid } = await pay(BigInt(stallId), "GET");
    if (!r.response.ok) throw new ToolError(`stall answered ${r.response.status}: ${JSON.stringify(r.data)}`);
    return { content: typeof r.data === "string" ? r.data : JSON.stringify(r.data, null, 2), paid };
  }

  async function buy_license(a: { stallId: string }) {
    const { content, paid } = await buyLicense(a.stallId);
    return { content, ...paid };
  }

  async function download_skill(a: { stallId: string }) {
    const { content, paid } = await buyLicense(a.stallId);
    const declared = content.match(/^---[\s\S]*?^name:\s*["']?([^"'\r\n]+)["']?\s*$/m)?.[1]?.trim();
    // The name comes from the seller, so it must be a plain folder name; anything else gets a safe one.
    let name = declared && SKILL_NAME.test(declared) ? declared : `stall-${a.stallId}-skill`;
    if (existsSync(join(cfg.skillsDir, name))) name = `${name}-stall${a.stallId}`; // never overwrite a skill the user already has
    const dir = resolve(cfg.skillsDir, name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), content);
    return { installed: join(dir, "SKILL.md"), name, ...paid };
  }

  async function create_task(a: { stallId: string; body: unknown }) {
    const s = await stall(BigInt(a.stallId));
    if (s.mode !== "task") throw new ToolError(`stall ${a.stallId} is a ${s.mode} stall; use ${TOOL_FOR_MODE[s.mode]}`);
    const { r, paid } = await pay(BigInt(a.stallId), "POST", undefined, a.body);
    if (!r.response.ok) return { status: r.response.status, error: r.data, ...paid };
    return { ...(r.data as Json), ...paid, note: "Funds are held in escrow. Poll get_task; release with approve_task once the result is in." };
  }

  async function get_task(a: { taskId: string }) {
    const t = await pub.readContract({ ...vault, functionName: "getTask", args: [BigInt(a.taskId)] });
    if (t.sessionId === 0n) throw new ToolError(`unknown task ${a.taskId}`);
    const out: Json = {
      taskId: a.taskId,
      stallId: t.stallId.toString(),
      status: TASK_STATUS[t.status],
      amount: tusd(t.amount),
      deadline: new Date(Number(t.deadline) * 1000).toISOString(),
    };
    if (t.status >= 2 && t.reviewEnd > 0n) out.autoReleaseAt = new Date(Number(t.reviewEnd) * 1000).toISOString();
    if (/^https?:\/\//.test(t.resultURI)) {
      const text = await fetch(t.resultURI, { signal: AbortSignal.timeout(10_000) }).then((r) => r.text()).catch(() => undefined);
      out.resultURI = t.resultURI;
      if (text !== undefined) {
        out.resultVerified = keccak256(toHex(text)) === t.resultHash;
        let parsed: unknown = text.length > 20_000 ? `${text.slice(0, 20_000)}...` : text;
        try {
          parsed = JSON.parse(text);
        } catch {
          // not JSON; keep the text
        }
        out.result = parsed;
      }
    }
    return out;
  }

  async function approve_task(a: { taskId: string }) {
    const r = await buyer.approveTask(BigInt(a.taskId), cfg.facilitatorUrl);
    return { released: true, taskId: a.taskId, amount: r.amount ? tusd(BigInt(r.amount)) : undefined, transaction: r.transaction };
  }

  async function rate_service(a: { receiptId: string; score: number; comment?: string }) {
    // shortcut: ReputationRegistry.rate has no signature variant, so the agent key pays its own gas; a relayed rateWithSig needs a registry redeploy (D16).
    const gas = await pub.getBalance({ address: agent.address });
    if (gas === 0n) throw new ToolError(`the agent key ${agent.address} holds no tQDAY for gas, so it cannot rate. The owner can rate receipt ${a.receiptId} from the web app.`);
    const wallet = createWalletClient({ chain, transport: http(rpc), account: agent });
    const { request } = await pub.simulateContract({ account: agent, address: d.ReputationRegistry, abi: reputationRegistryAbi, functionName: "rate", args: [BigInt(a.receiptId), a.score, a.comment ?? ""] });
    const hash = await wallet.writeContract({ ...request, type: "legacy" } as never);
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new ToolError("rating reverted");
    return { rated: true, receiptId: a.receiptId, score: a.score, transaction: hash };
  }

  async function close_channels() {
    const closed = [];
    for (const [stallId, ch] of [...buyer.channels.entries()]) {
      if (await buyer.closeChannel(stallId)) closed.push({ stallId: stallId.toString(), channelId: ch.channelId.toString(), paid: tusd(ch.owed), refundAfterWindow: tusd(ch.deposit - ch.owed) });
    }
    return { closed, note: "Unused deposits return to the owner's vault balance after the close window." };
  }

  return { market_search, wallet_status, call_service, buy_license, download_skill, create_task, get_task, approve_task, rate_service, close_channels, budget };
}

export type MarketTools = ReturnType<typeof createMarketTools>;

const uint = z.string().regex(/^\d+$/, "a whole number as a string");
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2);

/** The MCP server: every result carries `budget`; refusals come back as readable errors with a code. */
export function createMcpServer(cfg: MarketConfig) {
  const tools = createMarketTools(cfg);
  const server = new McpServer({ name: "clawdford-market", version: "0.1.0" });

  function register<S extends z.ZodRawShape>(name: string, description: string, inputSchema: S, run: (a: z.infer<z.ZodObject<S>>) => Promise<Json>) {
    server.registerTool(name, { description, inputSchema }, (async (a: z.infer<z.ZodObject<S>>) => {
      let body: Json;
      let isError = false;
      try {
        body = await run(a);
      } catch (err) {
        isError = true;
        body = err instanceof PaymentRefused ? { refused: err.code, reason: err.message, charged: "nothing" } : { error: err instanceof Error ? err.message : String(err) };
      }
      body.budget = await tools.budget().catch(() => "unavailable");
      return { content: [{ type: "text" as const, text: json(body) }], isError };
    }) as never);
  }

  register("market_search", "Find paid AI services (stalls) on Clawdford Market by text, category, mode or max unit price. Shows price, rating, how to call each stall and whether your session may pay it.", {
    query: z.string().optional().describe("words to match, e.g. 'case law search'"),
    category: z.enum(CATEGORIES).optional(),
    mode: z.enum(MODES).optional(),
    maxPrice: z.string().regex(/^\d+(\.\d{1,6})?$/).optional().describe("max unit price in tUSD8, e.g. '0.01'"),
  }, tools.market_search);
  register("wallet_status", "Your session: caps, spent today and in total, remaining, expiry, revoked, open channels.", {}, tools.wallet_status);
  register("call_service", "Call an exact or stream stall and pay for it from your session. The payee and price are checked against the chain before anything is signed.", {
    stallId: uint,
    method: z.enum(["GET", "POST"]).optional().describe("defaults to POST when a body is given, else GET"),
    query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    body: z.unknown().optional().describe("JSON body for POST stalls"),
  }, tools.call_service);
  register("buy_license", "Buy a license from a license stall and return what it sells (for example a skill file).", { stallId: uint }, tools.buy_license);
  register("download_skill", "Buy a skill license and install the skill as <skills dir>/<name>/SKILL.md.", { stallId: uint }, tools.download_skill);
  register("create_task", "Hire a task stall. The price is held in escrow until you approve the result (or it auto-releases after the review window).", { stallId: uint, body: z.unknown().describe("the task request, as the stall's usage describes") }, tools.create_task);
  register("get_task", "Task status and, once submitted, the result (checked against the on-chain result hash).", { taskId: uint }, tools.get_task);
  register("approve_task", "Release a submitted task's escrow to the seller. Only works if the owner allowed the agent to approve.", { taskId: uint }, tools.approve_task);
  register("rate_service", "Rate a paid call 1 to 5 by its receipt id.", { receiptId: uint, score: z.number().int().min(1).max(5), comment: z.string().max(500).optional() }, tools.rate_service);
  register("close_channels", "Close all open stream channels; the unused deposit returns to the owner after the close window.", {}, tools.close_channels);

  return server;
}
