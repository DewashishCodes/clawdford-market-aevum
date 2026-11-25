import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const dataFile = (name: string) => readFileSync(new URL(`../data/${name}`, import.meta.url), "utf8");

/** Parses CSV with a header row and double-quoted fields ("" is a literal quote). */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (field += '"'), i++;
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") row.push(field), (field = "");
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field), (field = "");
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  const [header = [], ...body] = rows;
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

const words = (s: string) => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];

export interface CaseNote {
  id: string;
  title: string;
  year: number;
  topic: string;
  note: string;
}

/**
 * Ranks notes by how many query words they contain (topic and title count double).
 * shortcut: keyword overlap, not embeddings; swap in a vector index once the corpus is bigger than a demo.
 */
export function searchNotes(notes: CaseNote[], query: string, k = 3) {
  const q = new Set(words(query));
  return notes
    .map((n) => {
      const head = words(`${n.topic} ${n.title}`).filter((w) => q.has(w)).length;
      const body = words(n.note).filter((w) => q.has(w)).length;
      return { ...n, score: head * 2 + body };
    })
    .filter((n) => n.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

/**
 * Deterministic hashed bag-of-words embedding, L2 normalised.
 * shortcut: no model behind it; good enough to show a paid compute job, swap for a real embedding model later.
 */
export function embed(text: string, dims = 64): number[] {
  const v = new Array<number>(dims).fill(0);
  for (const w of words(text)) {
    const h = createHash("sha256").update(w).digest();
    const i = h.readUInt32BE(0) % dims;
    v[i] = v[i]! + (h.readUInt8(4) & 1 ? 1 : -1);
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => Math.round((x / norm) * 1e4) / 1e4);
}

export const CLAUSES = parseCsv(dataFile("clauses.csv"));
export const CASE_NOTES = JSON.parse(dataFile("cases.json")) as CaseNote[];
export const RISK_MEMO_SKILL = dataFile("risk-memo-skill.md");
