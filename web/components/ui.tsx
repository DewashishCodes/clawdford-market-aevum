import type { ReactNode } from "react";
import { short } from "@/lib/format";

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "accent" | "good" | "bad" | "warn" }) {
  const tones = {
    neutral: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
    accent: "bg-accent-soft text-accent-strong",
    good: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
    bad: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
    warn: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  };
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>{children}</span>;
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="card">
      <div className="label">{label}</div>
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-1 text-xs text-zinc-500">{hint}</div>}
    </div>
  );
}

/** Explorer link when the chain has one, else the shortened hash. */
export function TxLink({ hash, explorer, kind = "tx" }: { hash?: string; explorer?: string; kind?: "tx" | "address" }) {
  if (!hash) return null;
  if (!explorer) return <span className="mono text-zinc-500">{short(hash)}</span>;
  return (
    <a className="mono text-accent hover:underline" href={`${explorer}/${kind}/${hash}`} target="_blank" rel="noreferrer">
      {short(hash)}
    </a>
  );
}

export function CopBadge({ cop }: { cop: "ok" | "mismatch" | "no_card" }) {
  if (cop === "ok") return <Badge tone="good">Payee confirmed</Badge>;
  if (cop === "mismatch") return <Badge tone="bad">Payee mismatch</Badge>;
  return <Badge tone="warn">No agent card</Badge>;
}

export function Stars({ average, count }: { average: number; count: number }) {
  if (!count) return <span className="text-xs text-zinc-500">Unrated</span>;
  return (
    <span className="text-xs text-zinc-600 dark:text-zinc-400">
      <span className="text-amber-500">{"★".repeat(Math.round(average))}</span> {average.toFixed(2)} ({count})
    </span>
  );
}

export function Bar({ used, cap, label }: { used: bigint; cap: bigint; label: string }) {
  const pct = cap === 0n ? 0 : Number((used * 1000n) / cap) / 10;
  return (
    <div>
      <div className="mb-1 flex justify-between text-xs text-zinc-500">
        <span>{label}</span>
        <span className="tabular-nums">{pct.toFixed(1)}%</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div className={`h-full ${pct > 90 ? "bg-red-500" : "bg-accent"}`} style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
    </div>
  );
}

export function PageTitle({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="mb-6">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {sub && <p className="mt-1 text-sm text-zinc-500">{sub}</p>}
    </div>
  );
}
