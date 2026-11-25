import { formatUnits } from "viem";

export const CATEGORIES = ["inference", "data", "tool", "knowledge", "skill", "weights", "compute", "human", "eval", "outcome"] as const;
export const MODES = ["exact", "stream", "task", "license"] as const;
export const TASK_STATUS = ["none", "open", "submitted", "disputed", "released", "refunded", "resolved"] as const;

/** tUSD8 base units (6 decimals) shown with 4 decimals (PRD 8.7). */
export function tusd(units: string | bigint | number | undefined) {
  if (units === undefined) return "";
  const n = Number(formatUnits(BigInt(units), 6));
  return `${n.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 })} tUSD8`;
}

export const short = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}...${a.slice(-4)}` : a);

export function ago(ms?: number) {
  if (!ms) return "";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return new Date(ms).toLocaleDateString();
}

/** JSON with bigints as strings, for API routes. */
export const toJson = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
