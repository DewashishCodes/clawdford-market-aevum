"use client";
import { useCallback, useEffect, useState } from "react";
import { parseEther, parseEventLogs, parseUnits, toHex, type Abi, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { agentVaultAbi, mockTUSD8Abi, reputationRegistryAbi } from "@clawdford/aevum/abis";
import { Badge, Bar, PageTitle, TxLink } from "@/components/ui";
import { CATEGORIES, ago, tusd } from "@/lib/format";
import { errorText, useWallet } from "@/lib/wallet";

interface Owner {
  vaultBalance: string;
  walletBalance: string;
  sessions: {
    sessionId: string;
    agentKey: Address;
    perPaymentCap: string;
    dailyCap: string;
    totalCap: string;
    spentToday: string;
    spentTotal: string;
    remainingToday: string;
    remainingTotal: string;
    expiry: number;
    categories: string[];
    revoked: boolean;
    agentCanApprove: boolean;
    channels: { channelId: string; stallId: string; deposit: string; claimed: string; closeAt: number; finalized: boolean }[];
  }[];
  receipts: { receiptId: string; stallId: string; amount: string; kind: string; time?: number; txHash: string; rated: boolean }[];
}

const units = (v: string) => {
  try {
    const n = parseUnits(v.trim(), 6);
    return n > 0n ? n : undefined;
  } catch {
    return undefined;
  }
};

function useAction() {
  const [busy, setBusy] = useState<string>();
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  const run = async (name: string, f: () => Promise<string | void>) => {
    setBusy(name);
    setMsg(undefined);
    try {
      const text = await f();
      if (text) setMsg({ ok: true, text });
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    } finally {
      setBusy(undefined);
    }
  };
  return { busy, msg, run };
}

function Msg({ msg }: { msg?: { ok: boolean; text: string } }) {
  if (!msg) return null;
  return <p className={`text-sm ${msg.ok ? "text-emerald-700 dark:text-emerald-400" : "text-red-600"}`}>{msg.text}</p>;
}

function Funds({ owner, refresh }: { owner: Owner; refresh: () => void }) {
  const w = useWallet();
  const c = w.config.contracts;
  const [amount, setAmount] = useState("3");
  const [out, setOut] = useState("");
  const { busy, msg, run } = useAction();

  const gasless = () =>
    run("gasless", async () => {
      const value = units(amount);
      if (!value) throw new Error("Enter an amount");
      const auth = { from: w.account!, to: c.AgentVault, value, validAfter: 0n, validBefore: BigInt(Math.floor(Date.now() / 1000) + 3600), nonce: toHex(crypto.getRandomValues(new Uint8Array(32))) };
      const signature = await w.signTypedData({
        domain: { name: "tUSD8", version: "2", chainId: w.config.chainId, verifyingContract: c.tUSD8 },
        types: { ReceiveWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
        primaryType: "ReceiveWithAuthorization",
        message: auth,
      });
      const res = await fetch("/api/deposit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: auth.from, amount: value.toString(), validAfter: "0", validBefore: auth.validBefore.toString(), nonce: auth.nonce, signature }),
      });
      const body = await res.json();
      if (!body.success) throw new Error(`Deposit refused: ${body.errorReason}`);
      refresh();
      return `Deposited ${tusd(value)} without gas. The facilitator paid it (tx ${body.transaction}).`;
    });

  const withApprove = () =>
    run("approve", async () => {
      const value = units(amount);
      if (!value) throw new Error("Enter an amount");
      await w.write(c.tUSD8, mockTUSD8Abi as Abi, "approve", [c.AgentVault, value]);
      await w.write(c.AgentVault, agentVaultAbi as Abi, "deposit", [value]);
      refresh();
      return `Deposited ${tusd(value)}.`;
    });

  const withdraw = () =>
    run("withdraw", async () => {
      const value = units(out);
      if (!value) throw new Error("Enter an amount");
      await w.write(c.AgentVault, agentVaultAbi as Abi, "withdraw", [value]);
      refresh();
      return `Withdrew ${tusd(value)} to your wallet.`;
    });

  return (
    <section className="card space-y-4">
      <h2 className="font-semibold">Funds</h2>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <div className="label">In your wallet</div>
          <div className="text-xl font-semibold tabular-nums">{tusd(owner.walletBalance)}</div>
        </div>
        <div>
          <div className="label">In the vault (agents spend from here)</div>
          <div className="text-xl font-semibold tabular-nums">{tusd(owner.vaultBalance)}</div>
        </div>
      </div>
      <div>
        <label className="label" htmlFor="dep">Deposit tUSD8</label>
        <div className="flex flex-wrap gap-2">
          <input id="dep" className="input max-w-32" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
          <button className="btn" disabled={!!busy} onClick={gasless}>
            {busy === "gasless" ? "Signing..." : "Deposit gasless"}
          </button>
          <button className="btn-ghost" disabled={!!busy} onClick={withApprove}>
            {busy === "approve" ? "Sending..." : "Approve + deposit"}
          </button>
        </div>
        <p className="mt-1 text-xs text-zinc-500">Gasless: you sign an EIP-3009 authorization and the facilitator submits it. The vault always credits the signer.</p>
      </div>
      <div>
        <label className="label" htmlFor="wd">Withdraw</label>
        <div className="flex gap-2">
          <input id="wd" className="input max-w-32" value={out} onChange={(e) => setOut(e.target.value)} inputMode="decimal" placeholder="0.5" />
          <button className="btn-ghost" disabled={!!busy} onClick={withdraw}>
            Withdraw
          </button>
        </div>
      </div>
      <Msg msg={msg} />
    </section>
  );
}

function NewSession({ refresh }: { refresh: () => void }) {
  const w = useWallet();
  const [f, setF] = useState({ perPayment: "0.2", daily: "1", total: "2", hours: "2", allow: "", agentCanApprove: false, gas: "0.005" });
  const [cats, setCats] = useState<string[]>(CATEGORIES.filter((c) => c !== "tool"));
  const [created, setCreated] = useState<{ sessionId: string; key: string }>();
  const { busy, msg, run } = useAction();

  const create = () =>
    run("create", async () => {
      const [perPaymentCap, dailyCap, totalCap] = [units(f.perPayment), units(f.daily), units(f.total)];
      const hours = Number(f.hours);
      if (!perPaymentCap || !dailyCap || !totalCap) throw new Error("Caps must be positive amounts");
      if (!(hours > 0)) throw new Error("Expiry must be a positive number of hours");
      const allow = f.allow.split(/[\s,]+/).filter(Boolean);
      if (allow.some((x) => !/^\d+$/.test(x))) throw new Error("Allowlist: stall ids separated by commas");
      const key = generatePrivateKey();
      const categoryMask = cats.reduce((m, c) => m | (1 << CATEGORIES.indexOf(c as never)), 0) >>> 0;
      const receipt = await w.write(w.config.contracts.AgentVault, agentVaultAbi as Abi, "createSession", [
        { agentKey: privateKeyToAccount(key).address, perPaymentCap, dailyCap, totalCap, expiry: BigInt(Math.floor(Date.now() / 1000 + hours * 3600)), categoryMask, agentCanApprove: f.agentCanApprove },
      ]);
      const [ev] = parseEventLogs({ abi: agentVaultAbi, logs: receipt.logs, eventName: "SessionCreated" });
      const sessionId = ev!.args.sessionId.toString();
      for (const id of allow) await w.write(w.config.contracts.AgentVault, agentVaultAbi as Abi, "setStallAllowed", [BigInt(sessionId), BigInt(id), true]);
      const gas = parseEther(f.gas || "0");
      if (gas > 0n) await w.sendGas(privateKeyToAccount(key).address, gas);
      setCreated({ sessionId, key });
      refresh();
    });

  const env = created && `-e SESSION_KEY=${created.key} -e SESSION_ID=${created.sessionId} -e CHAIN_ID=${w.config.chainId}${w.config.chainId === 44005 ? "" : ` -e RPC_URL=${w.config.rpcUrl}`} -e FACILITATOR_URL=${w.config.facilitatorUrl}`;
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: k === "agentCanApprove" ? e.target.checked : e.target.value });

  return (
    <section className="card space-y-4">
      <div>
        <h2 className="font-semibold">Give an agent a budget</h2>
        <p className="text-sm text-zinc-500">Creates a session for a new agent key. The vault enforces every limit; you can revoke it instantly.</p>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {(
          [
            ["perPayment", "Per payment"],
            ["daily", "Per day"],
            ["total", "Total"],
            ["hours", "Expires in (hours)"],
          ] as const
        ).map(([k, label]) => (
          <div key={k}>
            <label className="label" htmlFor={k}>{label}</label>
            <input id={k} className="input" value={f[k]} onChange={set(k)} inputMode="decimal" />
          </div>
        ))}
      </div>
      <fieldset>
        <legend className="label">Categories the agent may pay</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {CATEGORIES.map((c) => (
            <label key={c} className="flex items-center gap-1.5 text-sm">
              <input type="checkbox" checked={cats.includes(c)} onChange={(e) => setCats(e.target.checked ? [...cats, c] : cats.filter((x) => x !== c))} />
              {c}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="allow">Only these stalls (optional)</label>
          <input id="allow" className="input" value={f.allow} onChange={set("allow")} placeholder="e.g. 5, 6, 7" />
        </div>
        <div>
          <label className="label" htmlFor="gas">Gas for the agent to rate (tQDAY, 0 for none)</label>
          <input id="gas" className="input" value={f.gas} onChange={set("gas")} inputMode="decimal" />
        </div>
        <label className="flex items-center gap-2 self-end pb-2 text-sm">
          <input type="checkbox" checked={f.agentCanApprove} onChange={set("agentCanApprove")} />
          Agent may approve task results itself
        </label>
      </div>
      <button className="btn" disabled={!!busy} onClick={create}>
        {busy === "create" ? "Creating..." : "Create session"}
      </button>
      <Msg msg={msg} />
      {created && (
        <div className="space-y-2 rounded-lg border border-accent bg-accent-soft/40 p-4">
          <p className="text-sm font-medium">Session {created.sessionId} is live. Copy the agent setup now: the key is shown only once and is not stored anywhere.</p>
          <div className="label">Claude Code</div>
          <pre className="mono overflow-x-auto whitespace-pre-wrap break-all rounded bg-zinc-100 p-3 dark:bg-zinc-950">{`claude mcp add clawdford-market ${env} -- pnpm --silent --filter @clawdford/mcp start`}</pre>
          <div className="label">Codex (~/.codex/config.toml)</div>
          <pre className="mono overflow-x-auto whitespace-pre-wrap break-all rounded bg-zinc-100 p-3 dark:bg-zinc-950">{`[mcp_servers.clawdford-market]
command = "pnpm"
args = ["--silent", "--dir", "<repo>/mcp", "start"]
env = { SESSION_KEY = "${created.key}", SESSION_ID = "${created.sessionId}", CHAIN_ID = "${w.config.chainId}",${w.config.chainId === 44005 ? "" : ` RPC_URL = "${w.config.rpcUrl}",`} FACILITATOR_URL = "${w.config.facilitatorUrl}" }`}</pre>
        </div>
      )}
    </section>
  );
}

function Sessions({ owner, refresh }: { owner: Owner; refresh: () => void }) {
  const w = useWallet();
  const { busy, msg, run } = useAction();
  const now = Date.now() / 1000;

  const revoke = (id: string) =>
    run(`revoke-${id}`, async () => {
      await w.write(w.config.contracts.AgentVault, agentVaultAbi as Abi, "revokeSession", [BigInt(id)]);
      refresh();
      return `Session ${id} revoked. The agent can't pay anymore; open channels are closing and their unused deposit comes back after the close window.`;
    });

  const closeChannel = (id: string, finalize: boolean) =>
    run(`ch-${id}`, async () => {
      await w.write(w.config.contracts.AgentVault, agentVaultAbi as Abi, finalize ? "finalizeClose" : "requestClose", [BigInt(id)]);
      refresh();
      return finalize ? `Channel ${id} closed; the unused deposit is back in your vault.` : `Channel ${id} is closing. The seller can still claim what it is owed until the window ends, then the rest comes back to you.`;
    });

  if (owner.sessions.length === 0) return null;
  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold">Agent sessions</h2>
      <Msg msg={msg} />
      {owner.sessions.map((s) => {
        const live = !s.revoked && s.expiry > now;
        return (
          <div key={s.sessionId} className="card space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <h3 className="font-semibold">Session {s.sessionId}</h3>
              {s.revoked ? <Badge tone="bad">Revoked</Badge> : s.expiry <= now ? <Badge>Expired</Badge> : <Badge tone="good">Live</Badge>}
              <span className="mono text-zinc-500">agent {s.agentKey}</span>
              {live && (
                <button className="ml-auto rounded-lg bg-red-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50" disabled={!!busy} onClick={() => revoke(s.sessionId)}>
                  {busy === `revoke-${s.sessionId}` ? "Revoking..." : "Revoke now"}
                </button>
              )}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Bar label={`Today: ${tusd(s.spentToday)} of ${tusd(s.dailyCap)}`} used={BigInt(s.spentToday)} cap={BigInt(s.dailyCap)} />
              <Bar label={`Total: ${tusd(s.spentTotal)} of ${tusd(s.totalCap)}`} used={BigInt(s.spentTotal)} cap={BigInt(s.totalCap)} />
            </div>
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-zinc-500">
              <span>Per payment: {tusd(s.perPaymentCap)}</span>
              <span>Expires: {new Date(s.expiry * 1000).toLocaleString()}</span>
              <span>Categories: {s.categories.join(", ") || "none"}</span>
              <span>Agent approves tasks: {s.agentCanApprove ? "yes" : "no"}</span>
            </div>
            {s.channels.length > 0 && (
              <div>
                <div className="label">Stream channels</div>
                <div className="space-y-1 text-sm">
                  {s.channels.map((ch) => (
                    <div key={ch.channelId} className="flex flex-wrap gap-x-4">
                      <span>Channel {ch.channelId}</span>
                      <span className="text-zinc-500">stall {ch.stallId}</span>
                      <span className="tabular-nums">
                        {tusd(ch.claimed)} claimed of {tusd(ch.deposit)}
                      </span>
                      <Badge tone={ch.finalized ? "neutral" : ch.closeAt ? "warn" : "good"}>{ch.finalized ? "closed, refunded" : ch.closeAt ? `closing, refund after ${new Date(ch.closeAt * 1000).toLocaleTimeString()}` : "open"}</Badge>
                      {!ch.finalized && !ch.closeAt && (
                        <button className="text-xs text-accent hover:underline disabled:opacity-50" disabled={!!busy} onClick={() => closeChannel(ch.channelId, false)}>
                          Close
                        </button>
                      )}
                      {!ch.finalized && ch.closeAt > 0 && ch.closeAt <= now && (
                        <button className="text-xs text-accent hover:underline disabled:opacity-50" disabled={!!busy} onClick={() => closeChannel(ch.channelId, true)}>
                          Get refund
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}

function Receipts({ owner, refresh }: { owner: Owner; refresh: () => void }) {
  const w = useWallet();
  const { busy, msg, run } = useAction();
  const rate = (receiptId: string, score: number) =>
    run(receiptId, async () => {
      await w.write(w.config.contracts.ReputationRegistry, reputationRegistryAbi as Abi, "rate", [BigInt(receiptId), score, ""]);
      refresh();
      return `Rated receipt ${receiptId}: ${score}/5.`;
    });
  if (owner.receipts.length === 0) return null;
  return (
    <section className="card !p-0">
      <h2 className="px-5 pt-4 font-semibold">What your agents bought</h2>
      <div className="px-5"><Msg msg={msg} /></div>
      <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
        {owner.receipts.map((r) => (
          <div key={`${r.kind}-${r.receiptId}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-2.5 text-sm">
            <span className="mono text-zinc-500">#{r.receiptId}</span>
            <a href={`/stall/${r.stallId}`} className="hover:text-accent">stall {r.stallId}</a>
            <span className="text-xs text-zinc-500">{r.kind}</span>
            <span className="tabular-nums">{tusd(r.amount)}</span>
            <span className="text-xs text-zinc-500">{ago(r.time)}</span>
            <TxLink hash={r.txHash} explorer={w.config.explorer} />
            <span className="ml-auto flex items-center gap-1">
              {r.rated ? (
                <span className="text-xs text-zinc-500">rated</span>
              ) : (
                <>
                  <span className="text-xs text-zinc-500">rate</span>
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button key={n} className="rounded px-1.5 text-sm text-amber-500 hover:bg-amber-100 disabled:opacity-40 dark:hover:bg-amber-950" disabled={!!busy} onClick={() => rate(r.receiptId, n)} aria-label={`Rate ${n} of 5`}>
                      {n}★
                    </button>
                  ))}
                </>
              )}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

export default function WalletPage() {
  const w = useWallet();
  const [owner, setOwner] = useState<Owner>();
  const [error, setError] = useState<string>();

  const refresh = useCallback(() => {
    if (!w.account) return;
    fetch(`/api/owner/${w.account}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((o) => (setOwner(o), setError(undefined)))
      .catch(() => setError("Could not load your account."));
  }, [w.account]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 4_000);
    return () => clearInterval(t);
  }, [refresh]);

  if (!w.account) {
    return (
      <div>
        <PageTitle title="Owner console" sub="Fund the vault, give agents budgets, watch them spend, revoke in one click." />
        <div className="card space-y-3">
          <p className="text-sm">Connect the wallet that holds your tUSD8.</p>
          <div className="flex gap-2">
            <button className="btn" onClick={() => w.connect().catch((e) => setError(errorText(e)))}>
              Connect wallet
            </button>
            {!w.isDev && (
              <button className="btn-ghost" onClick={() => w.addChain().catch((e) => setError(errorText(e)))}>
                Add Aevum to wallet
              </button>
            )}
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageTitle title="Owner console" sub="Fund the vault, give agents budgets, watch them spend, revoke in one click." />
      {w.wrongChain && <p className="rounded-lg bg-red-100 px-4 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">Your wallet is on another network. Use "Add Aevum to wallet" to switch.</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}
      {!owner ? (
        <p className="text-sm text-zinc-500">Loading...</p>
      ) : (
        <>
          <div className="grid gap-6 lg:grid-cols-2">
            <Funds owner={owner} refresh={refresh} />
            <NewSession refresh={refresh} />
          </div>
          <Sessions owner={owner} refresh={refresh} />
          <Receipts owner={owner} refresh={refresh} />
        </>
      )}
    </div>
  );
}
