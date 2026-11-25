import { describe, expect, it } from "vitest";
import { CASE_NOTES, CLAUSES, embed, parseCsv, searchNotes } from "../src/data.js";

describe("parseCsv", () => {
  it("handles quotes, escaped quotes, commas and CRLF", () => {
    expect(parseCsv('a,b\r\n1,"x, ""y"""\r\n2,z\n')).toEqual([
      { a: "1", b: 'x, "y"' },
      { a: "2", b: "z" },
    ]);
  });

  it("parses the bundled clause dataset", () => {
    expect(CLAUSES).toHaveLength(25);
    expect(CLAUSES[0]).toMatchObject({ id: "1", type: "indemnity", risk: "high" });
    expect(CLAUSES.every((c) => c.clause && c.note)).toBe(true);
  });
});

describe("searchNotes", () => {
  it("ranks topic matches first and drops misses", () => {
    const r = searchNotes(CASE_NOTES, "non-compete restraint");
    expect(r[0]?.id).toBe("C-005");
    expect(searchNotes(CASE_NOTES, "zzzz")).toEqual([]);
  });
});

describe("embed", () => {
  it("is deterministic, unit length and sensitive to the text", () => {
    const a = embed("indemnity cap");
    expect(a).toEqual(embed("indemnity cap"));
    expect(Math.hypot(...a)).toBeCloseTo(1, 3);
    expect(a).not.toEqual(embed("termination notice"));
  });
});
