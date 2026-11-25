"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Badge, PageTitle } from "@/components/ui";
import { tusd } from "@/lib/format";
import { errorText } from "@/lib/wallet";

interface Task {
  taskId: string;
  sessionId: string;
  stallId: string;
  amount: string;
  status: string;
  deadline: number;
  reviewEnd: number;
  resultURI: string;
}
interface Review {
  taskId: string;
  document: string;
  question: string;
  receivedAt: string;
  decision?: { approved: boolean; note: string };
}

const TONE: Record<string, "neutral" | "accent" | "good" | "bad" | "warn"> = { open: "accent", submitted: "warn", released: "good", refunded: "neutral", disputed: "bad", resolved: "neutral" };
const TOKEN_KEY = "clawdford.reviewer";

function ReviewQueue({ stallId }: { stallId: string }) {
  const [token, setToken] = useState("");
  const [queue, setQueue] = useState<Review[]>();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string>();
  const [busy, setBusy] = useState<string>();

  useEffect(() => {
    try {
      setToken(sessionStorage.getItem(TOKEN_KEY) ?? "");
    } catch {
      // storage blocked: the reviewer types the token each time
    }
  }, []);

  const load = useCallback(async () => {
    if (!token) return;
    const res = await fetch(`/api/review?stallId=${stallId}`, { headers: { authorization: `Bearer ${token}` }, cache: "no-store" });
    const body = await res.json();
    if (!res.ok) return setMsg(body.error ?? `error ${res.status}`);
    setQueue(body as Review[]);
    try {
      sessionStorage.setItem(TOKEN_KEY, token);
    } catch {}
  }, [token, stallId]);

  async function decide(taskId: string, approved: boolean) {
    setBusy(taskId);
    try {
      const res = await fetch("/api/review", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ stallId, taskId, approved, note: notes[taskId] ?? "" }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `error ${res.status}`);
      setMsg(`Task ${taskId} ${approved ? "approved" : "rejected"}; the result is on chain.`);
      await load();
    } catch (e) {
      setMsg(errorText(e));
    } finally {
      setBusy(undefined);
    }
  }

  const pending = queue?.filter((r) => !r.decision) ?? [];
  return (
    <section className="card space-y-4">
      <div>
        <h2 className="font-semibold">Human review queue (stall {stallId})</h2>
        <p className="text-sm text-zinc-500">For the reviewer: approve or reject each request. Your decision is submitted on chain as the task result.</p>
      </div>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setMsg(undefined);
          void load();
        }}
      >
        <label className="sr-only" htmlFor="token">Reviewer token</label>
        <input id="token" className="input max-w-xs" type="password" placeholder="Reviewer token" value={token} onChange={(e) => setToken(e.target.value)} />
        <button className="btn-ghost">Load queue</button>
      </form>
      {msg && <p className="text-sm text-zinc-600 dark:text-zinc-300">{msg}</p>}
      {queue && pending.length === 0 && <p className="text-sm text-zinc-500">Nothing waiting for review.</p>}
      {pending.map((r) => (
        <div key={r.taskId} className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <div className="mb-2 flex items-center gap-2 text-sm">
            <span className="font-medium">Task {r.taskId}</span>
            <span className="text-xs text-zinc-500">{new Date(r.receivedAt).toLocaleString()}</span>
          </div>
          <p className="mb-1 text-sm font-medium">{r.question}</p>
          <pre className="mono mb-3 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-zinc-100 p-3 dark:bg-zinc-950">{r.document}</pre>
          <label className="label" htmlFor={`note-${r.taskId}`}>Note to the buyer</label>
          <input id={`note-${r.taskId}`} className="input mb-3" value={notes[r.taskId] ?? ""} onChange={(e) => setNotes({ ...notes, [r.taskId]: e.target.value })} />
          <div className="flex gap-2">
            <button className="btn" disabled={busy === r.taskId} onClick={() => decide(r.taskId, true)}>
              Approve
            </button>
            <button className="btn-ghost" disabled={busy === r.taskId} onClick={() => decide(r.taskId, false)}>
              Reject
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}

export default function Tasks() {
  const [tasks, setTasks] = useState<Task[]>();
  const [humanStalls, setHumanStalls] = useState<string[]>([]);

  useEffect(() => {
    let live = true;
    const load = () =>
      fetch("/api/tasks", { cache: "no-store" })
        .then((r) => r.json())
        .then((t) => live && setTasks(t))
        .catch(() => {});
    void load();
    fetch("/api/stalls?category=human")
      .then((r) => r.json())
      .then((s: { id: string }[]) => live && setHumanStalls(s.map((x) => x.id)))
      .catch(() => {});
    const t = setInterval(load, 4_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);

  return (
    <div className="space-y-6">
      <PageTitle title="Tasks" sub="Escrowed jobs: the price is held in the vault until the buyer approves the result, or it auto-releases after the review window." />
      {humanStalls.map((id) => (
        <ReviewQueue key={id} stallId={id} />
      ))}
      <section className="card overflow-x-auto !p-0">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase text-zinc-500">
            <tr>
              <th className="px-5 py-3">Task</th>
              <th>Stall</th>
              <th>Session</th>
              <th>Amount</th>
              <th>Status</th>
              <th className="pr-5">Result</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {tasks?.length === 0 && (
              <tr>
                <td className="px-5 py-4 text-zinc-500" colSpan={6}>
                  No tasks yet.
                </td>
              </tr>
            )}
            {tasks?.map((t) => (
              <tr key={t.taskId}>
                <td className="px-5 py-2.5 font-medium">{t.taskId}</td>
                <td>
                  <Link href={`/stall/${t.stallId}`} className="text-accent hover:underline">
                    {t.stallId}
                  </Link>
                </td>
                <td>{t.sessionId}</td>
                <td className="tabular-nums">{tusd(t.amount)}</td>
                <td>
                  <Badge tone={TONE[t.status] ?? "neutral"}>{t.status}</Badge>
                </td>
                <td className="pr-5">
                  {/^https?:\/\//.test(t.resultURI) ? (
                    <a href={t.resultURI} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                      view
                    </a>
                  ) : (
                    <span className="text-zinc-500">{t.status === "open" ? "waiting" : ""}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
