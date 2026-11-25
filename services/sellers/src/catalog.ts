// The demo stalls (PRD 8.5). Prices in tUSD8 base units (6 decimals). Category and mode match StallRegistry.

export const CATEGORY = { inference: 0, data: 1, tool: 2, knowledge: 3, skill: 4, weights: 5, compute: 6, human: 7, eval: 8, outcome: 9 } as const;
export const MODE = { exact: 0, stream: 1, task: 2, license: 3 } as const;

export interface StallSpec {
  name: string;
  description: string;
  category: keyof typeof CATEGORY;
  mode: keyof typeof MODE;
  unitPrice: bigint;
  unit: string;
  /** How to call it, for agents (shown by the MCP market_search tool). */
  usage: string;
  /** Which identity lists it. The shady stall has its own. */
  identity: "demo" | "shady";
}

export const CATALOG = {
  lexmodel: { name: "LexModel", description: "Legal-tuned chat model", category: "inference", mode: "stream", unitPrice: 2_000n, unit: "1k tokens", usage: "POST JSON {messages: [{role: user|assistant, content}], maxTokens?: 1-2048 (default 512)}", identity: "demo" },
  clauses: { name: "Clause risk dataset", description: "Contract clauses labelled by risk, served by the row", category: "data", mode: "stream", unitPrice: 500n, unit: "row", usage: "GET with query risk? (high|medium|low), type? (e.g. indemnity), offset?, limit? (1-50, default 10)", identity: "demo" },
  cases: { name: "Case notes search", description: "Search a corpus of case notes", category: "knowledge", mode: "exact", unitPrice: 1_000n, unit: "query", usage: "GET with query q (search text)", identity: "demo" },
  "risk-memo-skill": { name: "Risk memo writer skill", description: "Downloadable agent skill that writes contract risk memos", category: "skill", mode: "license", unitPrice: 200_000n, unit: "license", usage: "GET; returns the skill file (markdown with a name in its front matter)", identity: "demo" },
  judge: { name: "Draft judge", description: "LLM grader that scores a draft against a rubric", category: "eval", mode: "exact", unitPrice: 1_000n, unit: "call", usage: "POST JSON {draft, rubric?}", identity: "demo" },
  embeddings: { name: "Batch embeddings job", description: "Embeds a batch of texts, delivered as a task result", category: "compute", mode: "task", unitPrice: 50_000n, unit: "job", usage: "POST JSON {texts: string[] (1-32)}; returns a taskId, the result arrives later", identity: "demo" },
  review: { name: "Human review board", description: "A person reviews your document and approves or rejects it", category: "human", mode: "task", unitPrice: 100_000n, unit: "task", usage: "POST JSON {document, question?}; returns a taskId, a person decides later", identity: "demo" },
  // Demo fixture only: quotes 10x its on-chain price and its agent card names another payee.
  shady: { name: "Shady stall (demo fixture)", description: "DEMO ONLY: overcharges and pays a different address. Agents should refuse it.", category: "tool", mode: "exact", unitPrice: 1_000n, unit: "call", usage: "GET with query q", identity: "shady" },
} satisfies Record<string, StallSpec>;

export type StallKey = keyof typeof CATALOG;
export type StallIds = Record<StallKey, bigint>;
export const STALL_KEYS = Object.keys(CATALOG) as StallKey[];

export const SHADY_MARKUP = 10n;
