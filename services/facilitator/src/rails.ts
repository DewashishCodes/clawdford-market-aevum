import { createRequire } from "node:module";
import type { DatabaseSync as DB } from "node:sqlite";

// shortcut: vite 5 (vitest 2) cannot resolve `node:sqlite` in an import, so load it with require; drop on vitest 3+.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

export interface Limits {
  perIpPerDay: number;
  perSessionPerDay: number;
  perDay: number;
}

export interface SettleEvent {
  ip: string;
  sessionId: string;
  scheme: string;
  action: string;
  ok: boolean;
  reason?: string;
  tx?: string;
  refId?: string;
  amount?: string;
  payer?: string;
}

export interface ActivityRow extends SettleEvent {
  id: number;
  ts: number;
}

const DAY_MS = 86_400_000;

/** Persistent settle log and per-UTC-day limits. Every settle attempt (ok or refused) is one row and counts. */
export class Rails {
  private db: DB;

  constructor(
    path: string,
    private limits: Limits,
    private now = () => Date.now(),
  ) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, ip TEXT NOT NULL, session_id TEXT NOT NULL,
        scheme TEXT NOT NULL, action TEXT NOT NULL, ok INTEGER NOT NULL,
        reason TEXT, tx TEXT, ref_id TEXT, amount TEXT, payer TEXT
      );
      CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
    `);
  }

  /** Reason code if this attempt would break a daily limit, else undefined. */
  check(ip: string, sessionId: string): string | undefined {
    const since = Math.floor(this.now() / DAY_MS) * DAY_MS;
    const count = (where: string, ...args: (string | number)[]) =>
      Number((this.db.prepare(`SELECT COUNT(*) AS n FROM events WHERE ts >= ? ${where}`).get(since, ...args) as { n: number }).n);
    if (count("") >= this.limits.perDay) return "rate_limited_global";
    if (count("AND ip = ?", ip) >= this.limits.perIpPerDay) return "rate_limited_ip";
    if (count("AND session_id = ?", sessionId) >= this.limits.perSessionPerDay) return "rate_limited_session";
    return undefined;
  }

  record(e: SettleEvent) {
    this.db
      .prepare(
        "INSERT INTO events (ts, ip, session_id, scheme, action, ok, reason, tx, ref_id, amount, payer) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(this.now(), e.ip, e.sessionId, e.scheme, e.action, e.ok ? 1 : 0, e.reason ?? null, e.tx ?? null, e.refId ?? null, e.amount ?? null, e.payer ?? null);
  }

  recent(limit = 50): ActivityRow[] {
    const rows = this.db.prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?").all(limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r.id),
      ts: Number(r.ts),
      ip: String(r.ip),
      sessionId: String(r.session_id),
      scheme: String(r.scheme),
      action: String(r.action),
      ok: r.ok === 1,
      reason: (r.reason as string | null) ?? undefined,
      tx: (r.tx as string | null) ?? undefined,
      refId: (r.ref_id as string | null) ?? undefined,
      amount: (r.amount as string | null) ?? undefined,
      payer: (r.payer as string | null) ?? undefined,
    }));
  }
}
