import Link from "next/link";
import { Stat, TxLink } from "@/components/ui";
import { ago, tusd } from "@/lib/format";
import { ctx } from "@/lib/server/ctx";
import { publicConfig } from "@/lib/server/public-config";
import { listStalls, stats } from "@/lib/server/queries";

const STEPS = [
  ["Owner sets a budget", "Deposit tUSD8 into AgentVault (gasless) and give your agent a session: per-payment, daily and total caps, categories, expiry. Revoke any time."],
  ["Agent shops by itself", "The MCP server holds only the session key. It finds stalls, checks the payee and price against the chain, and signs payments within the caps."],
  ["Sellers earn per request", "Stalls answer HTTP 402 with a signed quote (x402). Exact calls, metered streams, licenses and escrowed tasks settle on Aevum."],
] as const;

export default async function Home() {
  const c = ctx();
  const [s, stalls, config] = await Promise.all([stats(c), listStalls(c), publicConfig()]);
  const name = new Map(stalls.map((x) => [x.id, x.name]));

  return (
    <div className="space-y-12">
      <section className="py-6">
        <p className="mb-3 text-sm font-medium text-accent">Built on QDay Aevum</p>
        <h1 className="max-w-3xl text-4xl font-semibold tracking-tight sm:text-5xl">Give your agent a budget, not a wallet.</h1>
        <p className="mt-4 max-w-2xl text-lg text-zinc-600 dark:text-zinc-400">
          Clawdford Market is where AI agents pay for models, data, skills and human review per request, in tUSD8, under limits their owners set on chain.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link href="/wallet" className="btn">
            Set up an agent budget
          </Link>
          <Link href="/market" className="btn-ghost">
            Browse the market
          </Link>
        </div>
      </section>

      <section className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="Stalls" value={s.stalls} />
        <Stat label="Payments" value={s.payments} />
        <Stat label="Settled" value={tusd(s.settled)} />
        <Stat label="Agent sessions" value={s.sessions} />
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        {STEPS.map(([title, body], i) => (
          <div key={title} className="card">
            <div className="mb-2 text-sm font-semibold text-accent">{i + 1}</div>
            <h2 className="font-semibold">{title}</h2>
            <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">{body}</p>
          </div>
        ))}
      </section>

      <section>
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">Latest receipts</h2>
          <Link href="/activity" className="text-sm text-accent hover:underline">
            All activity
          </Link>
        </div>
        <div className="card divide-y divide-zinc-100 !p-0 dark:divide-zinc-800">
          {s.latest.length === 0 && <p className="p-5 text-sm text-zinc-500">No payments yet.</p>}
          {s.latest.map((r) => (
            <div key={`${r.kind}-${r.receiptId}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 text-sm">
              <span className="mono text-zinc-500">#{r.receiptId}</span>
              <Link href={`/stall/${r.stallId}`} className="font-medium hover:text-accent">
                {name.get(r.stallId) ?? `Stall ${r.stallId}`}
              </Link>
              <span className="text-xs text-zinc-500">{r.kind}</span>
              <span className="ml-auto tabular-nums">{tusd(r.amount)}</span>
              <span className="w-16 text-right text-xs text-zinc-500">{ago(r.time)}</span>
              <TxLink hash={r.txHash} explorer={config.explorer} />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
