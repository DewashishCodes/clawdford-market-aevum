import Link from "next/link";
import { parseUnits } from "viem";
import { Badge, CopBadge, PageTitle, Stars } from "@/components/ui";
import { CATEGORIES, MODES, tusd } from "@/lib/format";
import { ctx } from "@/lib/server/ctx";
import { listStalls } from "@/lib/server/queries";

type Search = Promise<{ q?: string; category?: string; mode?: string; maxPrice?: string }>;

export default async function Market({ searchParams }: { searchParams: Search }) {
  const f = await searchParams;
  let max: bigint | undefined;
  try {
    max = f.maxPrice ? parseUnits(f.maxPrice, 6) : undefined;
  } catch {
    max = undefined;
  }
  const words = (f.q ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const stalls = (await listStalls(ctx())).filter(
    (s) =>
      s.active &&
      (!f.category || s.category === f.category) &&
      (!f.mode || s.mode === f.mode) &&
      (max === undefined || BigInt(s.unitPrice) <= max) &&
      words.every((w) => `${s.name} ${s.description ?? ""} ${s.category} ${s.unit}`.toLowerCase().includes(w)),
  );

  return (
    <div>
      <PageTitle title="Market" sub="Every stall is staked on chain. Agents check the payee against the agent card before paying." />
      <form className="card mb-6 grid gap-3 sm:grid-cols-5" method="get">
        <div className="sm:col-span-2">
          <label className="label" htmlFor="q">Search</label>
          <input className="input" id="q" name="q" defaultValue={f.q} placeholder="case law, chat, dataset..." />
        </div>
        <div>
          <label className="label" htmlFor="category">Category</label>
          <select className="input" id="category" name="category" defaultValue={f.category ?? ""}>
            <option value="">Any</option>
            {CATEGORIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="mode">Mode</label>
          <select className="input" id="mode" name="mode" defaultValue={f.mode ?? ""}>
            <option value="">Any</option>
            {MODES.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="maxPrice">Max unit price</label>
          <div className="flex gap-2">
            <input className="input" id="maxPrice" name="maxPrice" defaultValue={f.maxPrice} placeholder="0.01" inputMode="decimal" />
            <button className="btn">Filter</button>
          </div>
        </div>
      </form>

      {stalls.length === 0 && <p className="text-sm text-zinc-500">No stalls match.</p>}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {stalls.map((s) => (
          <Link key={s.id} href={`/stall/${s.id}`} className="card flex flex-col gap-3 transition hover:border-accent">
            <div className="flex items-start justify-between gap-2">
              <div>
                <h2 className="font-semibold">{s.name}</h2>
                <p className="text-xs text-zinc-500">
                  #{s.id} · {s.domain}
                </p>
              </div>
              <CopBadge cop={s.cop} />
            </div>
            {s.description && <p className="text-sm text-zinc-600 dark:text-zinc-400">{s.description}</p>}
            <div className="mt-auto flex flex-wrap items-center gap-2">
              <Badge tone="accent">{s.category}</Badge>
              <Badge>{s.mode}</Badge>
              <Stars {...s.rating} />
            </div>
            <div className="text-sm font-medium tabular-nums">
              {tusd(s.unitPrice)} <span className="font-normal text-zinc-500">per {s.unit}</span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
