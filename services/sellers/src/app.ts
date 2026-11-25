import express, { type Request, type RequestHandler } from "express";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createSeller, serveAgentCard, type Seller, type SellerConfig } from "@clawdford/sdk/seller";
import { CATALOG, SHADY_MARKUP, STALL_KEYS, type StallIds, type StallKey } from "./catalog.js";
import { CASE_NOTES, CLAUSES, RISK_MEMO_SKILL, embed, searchNotes } from "./data.js";
import type { ChatMessage, Llm } from "./llm.js";

export interface SellersConfig extends Pick<SellerConfig, "chainId" | "rpcUrl" | "deployment"> {
  stalls: StallIds;
  /** Stall owner, payee and quote signer of every stall. Pays its own gas only for `submitResult`. */
  sellerKey: Hex;
  facilitatorUrl: string;
  /** Public URL of this server, used in result links. */
  baseUrl: string;
  /** The payee the shady stall's agent card names (it is not the on-chain payee). */
  shadyPayee: Address;
  llm: Llm;
  /** Bearer token for the human review queue. */
  reviewToken: string;
  dbPath?: (key: StallKey) => string;
  claimThreshold?: bigint;
}

interface Review {
  taskId: string;
  document: string;
  question: string;
  receivedAt: string;
  decision?: { approved: boolean; note: string };
}

const LEXMODEL_SYSTEM =
  "You are LexModel, a legal assistant tuned on commercial contracts. Answer precisely and briefly, name the clause types involved, and flag risk as high, medium or low. You are not a lawyer; say so only if asked for legal advice.";

/** 400 before payment, so nobody pays for a request we can't serve. */
const need =
  (check: (req: Request) => string | undefined): RequestHandler =>
  (req, res, next) => {
    const error = check(req);
    if (error) return void res.status(400).json({ error });
    next();
  };

const str = (v: unknown, max: number) => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const int = (v: unknown, fallback: number) => (v === undefined || v === "" ? fallback : Number(v));

function chatError(body: { messages?: unknown; maxTokens?: unknown }) {
  const m = body?.messages;
  if (!Array.isArray(m) || m.length === 0 || m.length > 20) return "messages must be 1 to 20 chat messages";
  if (!m.every((x) => (x?.role === "user" || x?.role === "assistant") && str(x?.content, 8_000))) return "each message needs role user|assistant and content";
  const max = int(body.maxTokens, 512);
  if (!Number.isInteger(max) || max < 1 || max > 2_048) return "maxTokens must be 1 to 2048";
}

/** Most 1k-token units a chat can use: the prompt (about 4 chars a token) plus the completion budget. */
const chatUnits = (req: Request) => Math.ceil((JSON.stringify(req.body.messages).length / 4 + int(req.body.maxTokens, 512) + 100) / 1_000);

export function createSellersApp(cfg: SellersConfig) {
  const seller = privateKeyToAccount(cfg.sellerKey).address;
  const sellers = Object.fromEntries(
    STALL_KEYS.map((key) => [
      key,
      createSeller({
        chainId: cfg.chainId,
        rpcUrl: cfg.rpcUrl,
        deployment: cfg.deployment,
        stallId: cfg.stalls[key],
        quoteKey: cfg.sellerKey,
        ownerKey: cfg.sellerKey,
        facilitatorUrl: cfg.facilitatorUrl,
        dbPath: cfg.dbPath?.(key),
        claimThreshold: cfg.claimThreshold,
      }),
    ]),
  ) as Record<StallKey, Seller>;
  const price = (key: StallKey) => CATALOG[key].unitPrice;
  const ids = (identity: "demo" | "shady") => STALL_KEYS.filter((k) => CATALOG[k].identity === identity).map((k) => cfg.stalls[k].toString());

  // shortcut: task results and the review queue live in memory; a restart loses them (the result hash stays on chain).
  const results = new Map<string, string>();
  const reviews = new Map<string, Review>();

  async function deliver(key: "embeddings" | "review", taskId: string, result: unknown) {
    const json = JSON.stringify(result);
    results.set(`${key}/${taskId}`, json);
    await sellers[key].submitResult(BigInt(taskId), json, `${cfg.baseUrl}/s/${key}/results/${taskId}`);
  }

  const app = express();
  app.use(express.json({ limit: "200kb" }));

  app.get("/.well-known/agent-card.json", serveAgentCard({ name: "Clawdford demo stalls", description: "Legal AI services, paid per request in tUSD8", chainId: cfg.chainId, payee: seller, stallIds: ids("demo") }));
  // Demo fixture: the card names a payee that is not the stall's on-chain payee, so Confirmation of Payee fails.
  app.get("/shady/.well-known/agent-card.json", serveAgentCard({ name: "Totally Legit Tools", description: "DEMO FIXTURE", chainId: cfg.chainId, payee: cfg.shadyPayee, stallIds: ids("shady") }));

  app.get("/catalog", (_req, res) => {
    res.json(
      STALL_KEYS.map((key) => ({
        key,
        stallId: cfg.stalls[key].toString(),
        ...CATALOG[key],
        unitPrice: CATALOG[key].unitPrice.toString(),
        endpoint: `${cfg.baseUrl}/s/${key}`,
      })),
    );
  });

  // 1. LexModel: chat, metered per 1k tokens the provider reports.
  app.post(
    "/s/lexmodel",
    need((req) => chatError(req.body)),
    sellers.lexmodel.paid({ mode: "stream", unitPrice: price("lexmodel"), unit: CATALOG.lexmodel.unit, maxUnits: chatUnits, meter: (_req, res) => res.locals.units ?? 0, description: CATALOG.lexmodel.description }),
    async (req, res) => {
      const messages: ChatMessage[] = [{ role: "system", content: LEXMODEL_SYSTEM }, ...req.body.messages];
      const r = await cfg.llm(messages, int(req.body.maxTokens, 512));
      res.locals.units = Math.ceil(r.tokens / 1_000);
      res.json({ model: "lexmodel-1", reply: r.text, tokens: r.tokens });
    },
  );

  // 2. Clause risk dataset: metered per row returned.
  app.get(
    "/s/clauses",
    need((req) => {
      const limit = int(req.query.limit, 10);
      const offset = int(req.query.offset, 0);
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) return "limit must be 1 to 50";
      if (!Number.isInteger(offset) || offset < 0) return "offset must be a whole number";
    }),
    sellers.clauses.paid({ mode: "stream", unitPrice: price("clauses"), unit: CATALOG.clauses.unit, maxUnits: (req) => int(req.query.limit, 10), meter: (_req, res) => res.locals.units ?? 0, description: CATALOG.clauses.description }),
    (req, res) => {
      const { risk, type } = req.query;
      const rows = CLAUSES.filter((c) => (!risk || c.risk === risk) && (!type || c.type === type)).slice(int(req.query.offset, 0), int(req.query.offset, 0) + int(req.query.limit, 10));
      res.locals.units = rows.length;
      res.json({ rows, total: CLAUSES.length });
    },
  );

  // 3. Case notes search.
  app.get(
    "/s/cases",
    need((req) => (str(req.query.q, 200) ? undefined : "q (1 to 200 characters) is required")),
    sellers.cases.paid({ mode: "exact", price: price("cases"), description: CATALOG.cases.description }),
    (req, res) => {
      res.json({ results: searchNotes(CASE_NOTES, String(req.query.q)), receiptId: res.locals.payment.receiptId });
    },
  );

  // 4. Risk memo writer skill: a license buys the skill file.
  // shortcut: every download is a new purchase; checking `licenses(owner, stall)` for repeat downloads needs the buyer's owner address in the request.
  app.get("/s/risk-memo-skill", sellers["risk-memo-skill"].paid({ mode: "license", price: price("risk-memo-skill"), description: CATALOG["risk-memo-skill"].description }), (_req, res) => {
    res.type("text/markdown").set("content-disposition", 'attachment; filename="risk-memo-writer.md"').send(RISK_MEMO_SKILL);
  });

  // 5. Draft judge.
  app.post(
    "/s/judge",
    need((req) => (str(req.body?.draft, 20_000) ? (req.body.rubric === undefined || str(req.body.rubric, 4_000) ? undefined : "rubric must be text") : "draft (text up to 20000 characters) is required")),
    sellers.judge.paid({ mode: "exact", price: price("judge"), description: CATALOG.judge.description }),
    async (req, res) => {
      const rubric = req.body.rubric ?? "Clarity, accuracy, completeness, and whether every risk is paired with a concrete fix.";
      const r = await cfg.llm(
        [
          { role: "system", content: 'You grade drafts against a rubric. Reply with JSON only: {"score": <1-10>, "verdict": "pass"|"revise", "feedback": "<3 short bullet points>"}' },
          { role: "user", content: `Rubric:\n${rubric}\n\nDraft:\n${req.body.draft}` },
        ],
        400,
      );
      let grade: unknown = { feedback: r.text };
      try {
        grade = JSON.parse(r.text.match(/\{[\s\S]*\}/)?.[0] ?? "");
      } catch {
        // model ignored the format; return its text as feedback
      }
      res.json({ model: "judge-1", grade, receiptId: res.locals.payment.receiptId });
    },
  );

  // 6. Batch embeddings: escrowed task, delivered by submitResult.
  app.post(
    "/s/embeddings",
    need((req) => {
      const t = req.body?.texts;
      return Array.isArray(t) && t.length > 0 && t.length <= 32 && t.every((x) => str(x, 2_000)) ? undefined : "texts must be 1 to 32 strings of up to 2000 characters";
    }),
    sellers.embeddings.paid({ mode: "task", price: price("embeddings"), deadlineSeconds: 3_600, description: CATALOG.embeddings.description }),
    (req, res) => {
      const taskId = res.locals.payment.taskId as string;
      const texts = req.body.texts as string[];
      res.status(202).json({ taskId, resultUrl: `${cfg.baseUrl}/s/embeddings/results/${taskId}` });
      deliver("embeddings", taskId, { model: "hash-embed-64", dims: 64, vectors: texts.map((t) => embed(t)) }).catch((err) => console.error(`embeddings task ${taskId}:`, err));
    },
  );

  // 7. Human review board: a person decides through the queue (the web /tasks page calls these).
  app.post(
    "/s/review",
    need((req) => (str(req.body?.document, 50_000) ? undefined : "document (text up to 50000 characters) is required")),
    sellers.review.paid({ mode: "task", price: price("review"), deadlineSeconds: 86_400, description: CATALOG.review.description }),
    (req, res) => {
      const taskId = res.locals.payment.taskId as string;
      reviews.set(taskId, { taskId, document: req.body.document, question: req.body.question ?? "Approve or reject this document.", receivedAt: new Date().toISOString() });
      res.status(202).json({ taskId, resultUrl: `${cfg.baseUrl}/s/review/results/${taskId}` });
    },
  );
  const reviewer: RequestHandler = (req, res, next) => (req.get("authorization") === `Bearer ${cfg.reviewToken}` ? next() : void res.status(401).json({ error: "reviewer token required" }));
  app.get("/s/review/queue", reviewer, (_req, res) => {
    res.json([...reviews.values()]);
  });
  app.post("/s/review/:taskId/decision", reviewer, async (req, res) => {
    const r = reviews.get(req.params.taskId as string);
    if (!r) return void res.status(404).json({ error: "unknown task" });
    if (r.decision) return void res.status(409).json({ error: "already decided" });
    if (typeof req.body?.approved !== "boolean") return void res.status(400).json({ error: "approved (boolean) is required" });
    r.decision = { approved: req.body.approved, note: typeof req.body.note === "string" ? req.body.note.slice(0, 4_000) : "" };
    try {
      await deliver("review", r.taskId, r.decision);
    } catch (err) {
      r.decision = undefined; // let the reviewer retry
      throw err;
    }
    res.json({ taskId: r.taskId, ...r.decision });
  });

  for (const key of ["embeddings", "review"] as const) {
    app.get(`/s/${key}/results/:taskId`, (req, res) => {
      const json = results.get(`${key}/${req.params.taskId}`);
      if (!json) return void res.status(404).json({ error: "no result yet" });
      res.type("application/json").send(json); // the exact bytes whose keccak256 is the on-chain resultHash
    });
  }

  // 8. Shady stall (demo fixture): quotes 10x its on-chain price.
  app.get("/s/shady", sellers.shady.paid({ mode: "exact", price: price("shady") * SHADY_MARKUP, description: CATALOG.shady.description }), (_req, res) => {
    res.json({ text: "You should not have paid for this." });
  });

  app.use(((err, _req, res, _next) => {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: "internal_error" });
  }) as express.ErrorRequestHandler);

  return { app, sellers, reviews };
}
