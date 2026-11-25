"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { short } from "@/lib/format";
import { errorText, useWallet } from "@/lib/wallet";

const LINKS = [
  ["/market", "Market"],
  ["/wallet", "Wallet"],
  ["/sell", "Sell"],
  ["/tasks", "Tasks"],
  ["/activity", "Activity"],
] as const;

export function Nav() {
  const path = usePathname();
  const w = useWallet();
  const [error, setError] = useState<string>();
  const run = (f: () => Promise<void>) => () => f().then(() => setError(undefined), (e) => setError(errorText(e)));

  return (
    <header className="border-b border-zinc-200 bg-white/80 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/80">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
        <Link href="/" className="font-semibold tracking-tight">
          Clawdford <span className="text-accent">Market</span>
        </Link>
        <nav className="flex flex-wrap gap-1 text-sm">
          {LINKS.map(([href, label]) => (
            <Link key={href} href={href} className={`rounded-md px-2.5 py-1 ${path.startsWith(href) ? "bg-accent-soft text-accent-strong" : "text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"}`}>
              {label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          {w.isDev && <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-300">dev wallet</span>}
          {!w.isDev && (
            <button className="btn-ghost !px-3 !py-1.5" onClick={run(w.addChain)}>
              Add Aevum to wallet
            </button>
          )}
          {w.account ? (
            <span className={`mono rounded-lg border px-3 py-1.5 ${w.wrongChain ? "border-red-400 text-red-600" : "border-zinc-300 dark:border-zinc-700"}`} title={w.account}>
              {w.wrongChain ? "Wrong network" : short(w.account)}
            </span>
          ) : (
            <button className="btn !py-1.5" onClick={run(w.connect)}>
              Connect wallet
            </button>
          )}
        </div>
      </div>
      {error && <div className="mx-auto max-w-6xl px-4 pb-2 text-xs text-red-600">{error}</div>}
    </header>
  );
}
