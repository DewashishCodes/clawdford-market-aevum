"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Badge, PageTitle, TxLink } from "@/components/ui";
import { ago, tusd } from "@/lib/format";
import type { ActivityRow } from "@/lib/server/queries";
import { useWallet } from "@/lib/wallet";

const TONE: Record<string, "neutral" | "accent" | "good" | "bad" | "warn"> = { payment: "good", claim: "good", refused: "bad", revoke: "bad", refund: "warn", deposit: "accent" };

export default function Activity() {
  const { config } = useWallet();
  const [data, setData] = useState<{ rows: ActivityRow[]; facilitator?: { address: string; lowBalance: boolean } }>();
  const [error, setError] = useState(false);

  useEffect(() => {
    let live = true;
    const load = () =>
      fetch("/api/activity", { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => live && (setData(d), setError(false)))
        .catch(() => live && setError(true));
    void load();
    const t = setInterval(load, 3_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);

  return (
    <div>
      <PageTitle title="Activity" sub="Payments, claims, refunds and revokes from the chain, plus payments the facilitator refused. Updates every 3 seconds." />
      {data?.facilitator?.lowBalance && <p className="mb-4 rounded-lg bg-amber-100 px-4 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">The facilitator is low on gas.</p>}
      {error && <p className="mb-4 text-sm text-red-600">Could not load activity.</p>}
      <div className="card divide-y divide-zinc-100 !p-0 dark:divide-zinc-800" aria-live="polite">
        {!data && <p className="p-5 text-sm text-zinc-500">Loading...</p>}
        {data?.rows.length === 0 && <p className="p-5 text-sm text-zinc-500">Nothing yet.</p>}
        {data?.rows.map((r, i) => (
          <div key={`${r.txHash ?? r.time}-${i}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 text-sm">
            <Badge tone={TONE[r.kind] ?? "neutral"}>{r.kind}</Badge>
            <span className={r.ok ? "" : "text-red-700 dark:text-red-400"}>{r.text}</span>
            {r.stallId && (
              <Link href={`/stall/${r.stallId}`} className="text-xs text-accent hover:underline">
                stall {r.stallId}
              </Link>
            )}
            <span className="ml-auto tabular-nums">{r.amount ? tusd(r.amount) : ""}</span>
            <span className="w-16 text-right text-xs text-zinc-500">{ago(r.time)}</span>
            <span className="w-28 text-right">
              <TxLink hash={r.txHash} explorer={config.explorer} />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
