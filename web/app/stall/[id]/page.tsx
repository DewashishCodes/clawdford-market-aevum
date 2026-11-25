import { notFound } from "next/navigation";
import { Badge, CopBadge, PageTitle, Stars, TxLink } from "@/components/ui";
import { ago, short, tusd } from "@/lib/format";
import { ctx } from "@/lib/server/ctx";
import { publicConfig } from "@/lib/server/public-config";
import { stallDetail } from "@/lib/server/queries";

export default async function StallPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^\d+$/.test(id)) notFound();
  const [detail, config] = await Promise.all([stallDetail(ctx(), BigInt(id)), publicConfig()]);
  if (!detail) notFound();
  const { stall: s, receipts, ratings, pendingUnstake } = detail;
  const toolFor = { exact: "call_service", stream: "call_service", license: "buy_license / download_skill", task: "create_task" }[s.mode] ?? "call_service";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageTitle title={s.name} sub={s.description} />
        <div className="flex gap-2">
          {!s.active && <Badge tone="bad">Inactive</Badge>}
          <CopBadge cop={s.cop} />
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <div className="card space-y-2 md:col-span-2">
          <div className="text-2xl font-semibold tabular-nums">
            {tusd(s.unitPrice)} <span className="text-base font-normal text-zinc-500">per {s.unit}</span>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge tone="accent">{s.category}</Badge>
            <Badge>{s.mode}</Badge>
            <Stars {...s.rating} />
          </div>
          <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1 pt-2 text-sm">
            <dt className="text-zinc-500">Endpoint</dt>
            <dd className="mono break-all">{s.endpoint}</dd>
            <dt className="text-zinc-500">Payee</dt>
            <dd>
              <TxLink hash={s.payee} explorer={config.explorer} kind="address" />
            </dd>
            <dt className="text-zinc-500">Identity</dt>
            <dd>
              #{s.identityId} {s.domain}
            </dd>
            <dt className="text-zinc-500">Agent card</dt>
            <dd className="mono break-all">{s.agentCardURI}</dd>
            <dt className="text-zinc-500">Stake</dt>
            <dd>
              {tusd(s.stake)}
              {pendingUnstake.amount !== "0" && <span className="text-zinc-500"> ({tusd(pendingUnstake.amount)} unstaking)</span>}
            </dd>
          </dl>
        </div>
        <div className="card">
          <div className="label">Example request</div>
          <p className="mb-3 text-sm">{s.usage ?? "See the seller's documentation."}</p>
          <div className="label">From an agent (MCP)</div>
          <pre className="mono overflow-x-auto rounded-lg bg-zinc-100 p-3 dark:bg-zinc-950">{`${toolFor}({ stallId: "${s.id}" ... })`}</pre>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <section className="card !p-0">
          <h2 className="px-5 pt-4 font-semibold">Receipts</h2>
          <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {receipts.length === 0 && <p className="px-5 py-4 text-sm text-zinc-500">No payments yet.</p>}
            {receipts.map((r) => (
              <div key={`${r.kind}-${r.receiptId}`} className="flex items-center gap-3 px-5 py-2.5 text-sm">
                <span className="mono text-zinc-500">#{r.receiptId}</span>
                <span className="text-xs text-zinc-500">session {r.sessionId}</span>
                <span className="ml-auto tabular-nums">{tusd(r.amount)}</span>
                <span className="w-16 text-right text-xs text-zinc-500">{ago(r.time)}</span>
                <TxLink hash={r.txHash} explorer={config.explorer} />
              </div>
            ))}
          </div>
        </section>
        <section className="card !p-0">
          <h2 className="px-5 pt-4 font-semibold">Ratings</h2>
          <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {ratings.length === 0 && <p className="px-5 py-4 text-sm text-zinc-500">No ratings yet.</p>}
            {ratings.map((r) => (
              <div key={r.receiptId} className="flex items-center gap-3 px-5 py-2.5 text-sm">
                <span className="text-amber-500">{"★".repeat(r.score)}</span>
                <span className="text-xs text-zinc-500">receipt #{r.receiptId} by {short(r.rater)}</span>
                <span className="ml-auto">
                  <TxLink hash={r.txHash} explorer={config.explorer} />
                </span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
