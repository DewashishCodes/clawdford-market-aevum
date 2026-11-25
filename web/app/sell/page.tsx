"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { parseEventLogs, parseUnits, type Abi } from "viem";
import { identityRegistryAbi, mockTUSD8Abi, stallRegistryAbi } from "@clawdford/aevum/abis";
import { PageTitle } from "@/components/ui";
import { CATEGORIES, MODES, tusd } from "@/lib/format";
import { errorText, useWallet } from "@/lib/wallet";

interface Identity {
  identityId: string;
  domain: string;
  agentCardURI: string;
}

const UNIT_FOR_MODE = { exact: "call", stream: "1k tokens", task: "job", license: "license" } as const;

export default function Sell() {
  const w = useWallet();
  const [identities, setIdentities] = useState<Identity[]>([]);
  const [newId, setNewId] = useState({ domain: "", card: "" });
  const [f, setF] = useState({ identityId: "", payee: "", quoteSigner: "", category: "inference", mode: "exact", price: "0.001", unit: "call", endpoint: "", metadataURI: "", stake: "", method: "GET" });
  const [check, setCheck] = useState<{ ok: boolean; problems: string[]; key: string }>();
  const [busy, setBusy] = useState<string>();
  const [msg, setMsg] = useState<{ ok: boolean; text: string; stallId?: string }>();

  const load = useCallback(() => {
    if (!w.account) return;
    fetch(`/api/owner/${w.account}`)
      .then((r) => r.json())
      .then((o: { identities: Identity[] }) => setIdentities(o.identities))
      .catch(() => {});
  }, [w.account]);
  useEffect(load, [load]);
  useEffect(() => {
    if (w.account) setF((x) => ({ ...x, payee: x.payee || w.account!, quoteSigner: x.quoteSigner || w.account! }));
  }, [w.account]);
  useEffect(() => setF((x) => ({ ...x, stake: x.stake || (Number(w.config.minStake) / 1e6).toString() })), [w.config.minStake]);

  const identity = identities.find((i) => i.identityId === f.identityId);
  const checkKey = `${f.endpoint}|${f.payee}|${identity?.agentCardURI}|${f.method}`;
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value, ...(k === "mode" ? { unit: UNIT_FOR_MODE[e.target.value as keyof typeof UNIT_FOR_MODE] } : {}) });

  async function act(name: string, fn: () => Promise<{ text: string; stallId?: string } | void>) {
    setBusy(name);
    setMsg(undefined);
    try {
      const r = await fn();
      if (r) setMsg({ ok: true, ...r });
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    } finally {
      setBusy(undefined);
    }
  }

  const register = () =>
    act("register", async () => {
      if (!newId.domain.trim()) throw new Error("Enter a domain");
      const receipt = await w.write(w.config.contracts.IdentityRegistry, identityRegistryAbi as Abi, "register", [newId.domain.trim().toLowerCase(), newId.card.trim()]);
      const [ev] = parseEventLogs({ abi: identityRegistryAbi, logs: receipt.logs, eventName: "IdentityRegistered" });
      const id = ev!.args.identityId.toString();
      setIdentities([...identities, { identityId: id, domain: newId.domain.trim().toLowerCase(), agentCardURI: newId.card.trim() }]);
      setF({ ...f, identityId: id });
      return { text: `Identity ${id} registered.` };
    });

  const runCheck = () =>
    act("check", async () => {
      if (!identity) throw new Error("Pick an identity first");
      const res = await fetch("/api/sell/check", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: f.endpoint, payee: f.payee, agentCardURI: identity.agentCardURI, method: f.method }) });
      setCheck({ ...(await res.json()), key: checkKey });
    });

  const list = () =>
    act("list", async () => {
      const unitPrice = parseUnits(f.price, 6);
      const stake = parseUnits(f.stake, 6);
      const c = w.config.contracts;
      await w.write(c.tUSD8, mockTUSD8Abi as Abi, "approve", [c.StallRegistry, stake]);
      const receipt = await w.write(c.StallRegistry, stallRegistryAbi as Abi, "createStall", [
        { identityId: BigInt(f.identityId), payee: f.payee, quoteSigner: f.quoteSigner, category: CATEGORIES.indexOf(f.category as never), mode: MODES.indexOf(f.mode as never), unitPrice, unit: f.unit, endpoint: f.endpoint, metadataURI: f.metadataURI, stake },
      ]);
      const [ev] = parseEventLogs({ abi: stallRegistryAbi, logs: receipt.logs, eventName: "StallCreated" });
      return { text: `Stall ${ev!.args.stallId} is listed.`, stallId: ev!.args.stallId.toString() };
    });

  if (!w.account) {
    return (
      <div>
        <PageTitle title="Sell on the market" sub="List an API, dataset, model or skill. Agents pay per request through x402." />
        <button className="btn" onClick={() => w.connect().catch((e) => setMsg({ ok: false, text: errorText(e) }))}>
          Connect wallet
        </button>
        {msg && <p className="mt-2 text-sm text-red-600">{msg.text}</p>}
      </div>
    );
  }

  const checked = check?.ok && check.key === checkKey;
  return (
    <div className="max-w-3xl space-y-6">
      <PageTitle title="Sell on the market" sub="List an API, dataset, model or skill. Agents pay per request through x402." />

      <section className="card space-y-3">
        <h2 className="font-semibold">1. Identity</h2>
        <p className="text-sm text-zinc-500">Your seller identity points at an agent card (JSON with your payee and stall ids) that buyers check before paying.</p>
        {identities.length > 0 && (
          <div>
            <label className="label" htmlFor="identity">Use identity</label>
            <select id="identity" className="input" value={f.identityId} onChange={set("identityId")}>
              <option value="">Choose...</option>
              {identities.map((i) => (
                <option key={i.identityId} value={i.identityId}>
                  #{i.identityId} {i.domain}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="grid gap-2 sm:grid-cols-[1fr_2fr_auto]">
          <input className="input" aria-label="Domain" placeholder="mystall.example" value={newId.domain} onChange={(e) => setNewId({ ...newId, domain: e.target.value })} />
          <input className="input" aria-label="Agent card URL" placeholder="https://mystall.example/.well-known/agent-card.json" value={newId.card} onChange={(e) => setNewId({ ...newId, card: e.target.value })} />
          <button className="btn-ghost" disabled={!!busy} onClick={register}>
            Register new
          </button>
        </div>
      </section>

      <section className="card space-y-3">
        <h2 className="font-semibold">2. Stall</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {(
            [
              ["endpoint", "Endpoint URL (answers 402)", "https://api.example/s/mystall"],
              ["metadataURI", "Metadata URL (name, description)", "https://api.example/catalog#mystall"],
              ["payee", "Payee (receives payments)", ""],
              ["quoteSigner", "Quote signer (signs 402 quotes)", ""],
              ["price", "Unit price (tUSD8)", "0.001"],
              ["unit", "Unit", "call"],
              ["stake", `Stake (min ${tusd(w.config.minStake)})`, ""],
            ] as const
          ).map(([k, label, ph]) => (
            <div key={k}>
              <label className="label" htmlFor={k}>{label}</label>
              <input id={k} className="input" value={f[k]} onChange={set(k)} placeholder={ph} />
            </div>
          ))}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="label" htmlFor="category">Category</label>
              <select id="category" className="input" value={f.category} onChange={set("category")}>
                {CATEGORIES.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="mode">Mode</label>
              <select id="mode" className="input" value={f.mode} onChange={set("mode")}>
                {MODES.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </section>

      <section className="card space-y-3">
        <h2 className="font-semibold">3. Check and list</h2>
        <p className="text-sm text-zinc-500">Before listing we call your endpoint: it must answer 402 with a quote that pays your payee, and your agent card must name the same payee.</p>
        <div className="flex flex-wrap items-center gap-2">
          <select className="input max-w-28" aria-label="Check method" value={f.method} onChange={set("method")}>
            <option>GET</option>
            <option>POST</option>
          </select>
          <button className="btn-ghost" disabled={!!busy || !f.endpoint} onClick={runCheck}>
            {busy === "check" ? "Checking..." : "Check endpoint"}
          </button>
          <button className="btn" disabled={!!busy || !checked} onClick={list}>
            {busy === "list" ? "Listing..." : "Stake and list"}
          </button>
        </div>
        {check && check.key === checkKey && (
          <div className={`rounded-lg p-3 text-sm ${check.ok ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300" : "bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-300"}`}>
            {check.ok ? "402 check passed: quote and agent card both pay your payee." : <ul className="list-disc pl-5">{check.problems.map((p) => <li key={p}>{p}</li>)}</ul>}
          </div>
        )}
      </section>

      {msg && (
        <p className={`text-sm ${msg.ok ? "text-emerald-700 dark:text-emerald-400" : "text-red-600"}`}>
          {msg.text}{" "}
          {msg.stallId && (
            <Link className="text-accent underline" href={`/stall/${msg.stallId}`}>
              View stall
            </Link>
          )}
        </p>
      )}
    </div>
  );
}
