import { describe, expect, it } from "vitest";
import { Rails } from "./rails.js";

const ev = (ip: string, sessionId: string, ok = true) => ({ ip, sessionId, scheme: "exact", action: "pay", ok });

describe("Rails", () => {
  it("enforces per-IP, per-session and global daily limits", () => {
    const r = new Rails(":memory:", { perIpPerDay: 2, perSessionPerDay: 3, perDay: 5 });
    expect(r.check("a", "1")).toBeUndefined();
    r.record(ev("a", "1"));
    r.record(ev("a", "2", false)); // refusals count too
    expect(r.check("a", "3")).toBe("rate_limited_ip");
    r.record(ev("b", "1"));
    r.record(ev("c", "1"));
    expect(r.check("d", "1")).toBe("rate_limited_session");
    r.record(ev("d", "4"));
    expect(r.check("e", "5")).toBe("rate_limited_global");
  });

  it("resets at the UTC day boundary", () => {
    let now = Date.UTC(2026, 10, 24, 23, 59);
    const r = new Rails(":memory:", { perIpPerDay: 1, perSessionPerDay: 9, perDay: 9 }, () => now);
    r.record(ev("a", "1"));
    expect(r.check("a", "1")).toBe("rate_limited_ip");
    now = Date.UTC(2026, 10, 25, 0, 1);
    expect(r.check("a", "1")).toBeUndefined();
  });

  it("lists recent events newest first", () => {
    const r = new Rails(":memory:", { perIpPerDay: 9, perSessionPerDay: 9, perDay: 9 });
    r.record(ev("a", "1"));
    r.record({ ...ev("a", "1", false), reason: "NonceAlreadyUsed" });
    const [last, first] = r.recent();
    expect(last).toMatchObject({ ok: false, reason: "NonceAlreadyUsed" });
    expect(first).toMatchObject({ ok: true, reason: undefined, sessionId: "1" });
  });
});
