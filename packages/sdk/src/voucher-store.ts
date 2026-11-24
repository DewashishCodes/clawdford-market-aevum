import { createRequire } from "node:module";
import type { DatabaseSync as DB } from "node:sqlite";
import type { Hex } from "viem";

// shortcut: vite 5 (vitest 2) cannot resolve `node:sqlite` in an import, so load it with require; drop on vitest 3+.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

export interface ChannelState {
  channelId: bigint;
  /** Metered cost served so far. */
  spent: bigint;
  /** Highest voucher received and its signature (what the settler claims). */
  best: bigint;
  sig?: Hex;
  /** Set once the channel is finalized on chain; the settler then ignores it. */
  done: boolean;
}

/** Seller-side channel state in SQLite, so a restart never loses a signed voucher. */
export class VoucherStore {
  private db: DB;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS channels (channel_id TEXT PRIMARY KEY, spent TEXT NOT NULL, best TEXT NOT NULL, sig TEXT, done INTEGER NOT NULL DEFAULT 0)",
    );
  }

  private row(r: Record<string, unknown>): ChannelState {
    return {
      channelId: BigInt(r.channel_id as string),
      spent: BigInt(r.spent as string),
      best: BigInt(r.best as string),
      sig: (r.sig as Hex | null) ?? undefined,
      done: r.done === 1,
    };
  }

  get(channelId: bigint): ChannelState {
    const r = this.db.prepare("SELECT * FROM channels WHERE channel_id = ?").get(channelId.toString());
    return r ? this.row(r as Record<string, unknown>) : { channelId, spent: 0n, best: 0n, done: false };
  }

  /** Keeps only the highest voucher. */
  saveVoucher(channelId: bigint, cumulative: bigint, sig: Hex) {
    const cur = this.get(channelId);
    if (cumulative <= cur.best && cur.sig) return;
    this.db
      .prepare(
        "INSERT INTO channels (channel_id, spent, best, sig) VALUES (?, ?, ?, ?) ON CONFLICT(channel_id) DO UPDATE SET best = excluded.best, sig = excluded.sig",
      )
      .run(channelId.toString(), cur.spent.toString(), cumulative.toString(), sig);
  }

  setSpent(channelId: bigint, spent: bigint) {
    this.db
      .prepare("INSERT INTO channels (channel_id, spent, best) VALUES (?, ?, '0') ON CONFLICT(channel_id) DO UPDATE SET spent = excluded.spent")
      .run(channelId.toString(), spent.toString());
  }

  markDone(channelId: bigint) {
    this.db.prepare("UPDATE channels SET done = 1 WHERE channel_id = ?").run(channelId.toString());
  }

  open(): ChannelState[] {
    return (this.db.prepare("SELECT * FROM channels WHERE done = 0").all() as Record<string, unknown>[]).map((r) => this.row(r));
  }
}
