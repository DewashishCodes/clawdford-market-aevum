"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Badge, Stars, Stat, TxLink } from "@/components/ui";
import { ago, tusd } from "@/lib/format";
import { useWallet } from "@/lib/wallet";

interface SellerData {
  feeBps: number;
  totals: { gross: string; net: string; payments: number; lockedInChannels: string };
  stalls: { id: string; name: string; mode: string; unitPrice: string; unit: string; active: boolean; stake: string; rating: { average: number; count: number }; payments: number; gross: string; net: string; pendingUnstake: { amount: string; unlockAt: number } }[];
  channels: { channelId: string; stallId: string; sessionId: string; deposit: string; claimed: string; closeAt: number }[];
  tasks: { taskId: string; stallId: string; amount: string; status: string; deadline: number }[];
  ratings: { stallId: string; receiptId: string; score: number; commentURI: string; txHash: string }[];
  receipts: { receiptId: string; stallId: string; amount: string; kind: string; txHash: string; time?: number }[];
}

/** Seller dashboard for the connected wallet: earnings, open channels, tasks in flight and ratings, all read from the chain. */
export function MyStalls() {
  const w = useWallet();
  const [data, setData] = useState<SellerData>();

  useEffect(() => {
    if (!w.account) return;
    let live = true;
    const load = () =>
      fetch(`/api/seller/${w.account}`)
        .then((r) => r.json())
        .then((d: SellerData) => live && setData(d))
        .catch(() => {});
    void load();
    const t = setInterval(load, 10_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [w.account]);

  if (!w.account || !data || data.stalls.length === 0) return null;
  const nameOf = (id: string) => data.stalls.find((s) => s.id === id)?.name ?? `Stall ${id}`;
  const now = Date.now() / 1000;

  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold">My stalls</h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Earned" value={tusd(data.totals.net)} hint={`after the ${data.feeBps / 100}% fee, ${tusd(data.totals.gross)} paid by agents`} />
        <Stat label="Payments" value={data.totals.payments} />
        <Stat label="In open channels" value={tusd(data.totals.lockedInChannels)} hint="deposits not yet claimed" />
        <Stat label="Tasks in flight" value={data.tasks.length} />
      </div>

      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-zinc-500">
            <tr>
              <th className="p-3">Stall</th>
              <th className="p-3">Price</th>
              <th className="p-3 text-right">Payments</th>
              <th className="p-3 text-right">Earned</th>
              <th className="p-3">Rating</th>
              <th className="p-3">Stake</th>
            </tr>
          </thead>
          <tbody>
            {data.stalls.map((s) => (
              <tr key={s.id} className="border-t border-zinc-200 dark:border-zinc-800">
                <td className="p-3">
                  <Link className="hover:underline" href={`/stall/${s.id}`}>
                    {s.name}
                  </Link>{" "}
                  <Badge>{s.mode}</Badge> {!s.active && <Badge tone="warn">paused</Badge>}
                </td>
                <td className="p-3 tabular-nums">
                  {tusd(s.unitPrice)} / {s.unit}
                </td>
                <td className="p-3 text-right tabular-nums">{s.payments}</td>
                <td className="p-3 text-right tabular-nums">{tusd(s.net)}</td>
                <td className="p-3">
                  <Stars average={s.rating.average} count={s.rating.count} />
                </td>
                <td className="p-3 tabular-nums">
                  {tusd(s.stake)}
                  {s.pendingUnstake.amount !== "0" && <div className="text-xs text-zinc-500">unstaking {tusd(s.pendingUnstake.amount)}, unlocks {new Date(s.pendingUnstake.unlockAt * 1000).toLocaleString()}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="card space-y-2">
          <h3 className="font-medium">Open channels</h3>
          {data.channels.length === 0 && <p className="text-sm text-zinc-500">None. Your settler claims vouchers and finalizes closed channels.</p>}
          {data.channels.map((ch) => (
            <div key={ch.channelId} className="flex justify-between text-sm">
              <span>
                Channel {ch.channelId}, {nameOf(ch.stallId)}, session {ch.sessionId}
              </span>
              <span className="tabular-nums text-zinc-500">
                {tusd(ch.claimed)} of {tusd(ch.deposit)} {ch.closeAt > 0 && (ch.closeAt > now ? <Badge tone="warn">closing</Badge> : <Badge>ready to finalize</Badge>)}
              </span>
            </div>
          ))}
        </div>
        <div className="card space-y-2">
          <h3 className="font-medium">Tasks in flight</h3>
          {data.tasks.length === 0 && <p className="text-sm text-zinc-500">No open tasks.</p>}
          {data.tasks.map((t) => (
            <div key={t.taskId} className="flex justify-between text-sm">
              <span>
                Task {t.taskId}, {nameOf(t.stallId)} <Badge tone={t.status === "disputed" ? "bad" : t.status === "submitted" ? "accent" : "neutral"}>{t.status}</Badge>
              </span>
              <span className="tabular-nums text-zinc-500">{tusd(t.amount)} in escrow</span>
            </div>
          ))}
          {data.tasks.length > 0 && (
            <Link className="text-sm text-accent hover:underline" href="/tasks">
              Open the review queue
            </Link>
          )}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="card space-y-2">
          <h3 className="font-medium">Latest payments</h3>
          {data.receipts.length === 0 && <p className="text-sm text-zinc-500">No payments yet.</p>}
          {data.receipts.slice(0, 8).map((r) => (
            <div key={`${r.kind}-${r.receiptId}`} className="flex justify-between gap-2 text-sm">
              <span>
                Receipt {r.receiptId}, {nameOf(r.stallId)} <Badge>{r.kind}</Badge>
              </span>
              <span className="flex gap-2 tabular-nums text-zinc-500">
                {tusd(r.amount)} <span>{ago(r.time)}</span> <TxLink hash={r.txHash} explorer={w.config.explorer} />
              </span>
            </div>
          ))}
        </div>
        <div className="card space-y-2">
          <h3 className="font-medium">Ratings</h3>
          {data.ratings.length === 0 && <p className="text-sm text-zinc-500">No ratings yet.</p>}
          {data.ratings.slice(0, 8).map((r) => (
            <div key={r.receiptId} className="flex justify-between text-sm">
              <span>
                <span className="text-amber-500">{"★".repeat(r.score)}</span> {nameOf(r.stallId)}, receipt {r.receiptId}
              </span>
              <TxLink hash={r.txHash} explorer={w.config.explorer} />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
