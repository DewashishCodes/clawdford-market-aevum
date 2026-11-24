import { describe, expect, it } from "vitest";
import { blockRanges } from "./logs.js";

describe("blockRanges", () => {
  it("splits into 1,000-block inclusive chunks", () => {
    expect(blockRanges(100n, 2599n)).toEqual([
      [100n, 1099n],
      [1100n, 2099n],
      [2100n, 2599n],
    ]);
  });

  it("returns a single range when from equals to", () => {
    expect(blockRanges(5n, 5n)).toEqual([[5n, 5n]]);
  });

  it("returns nothing when from is past to", () => {
    expect(blockRanges(10n, 9n)).toEqual([]);
  });

  it("never exceeds the chunk size", () => {
    for (const [a, b] of blockRanges(0n, 12_345n, 1000n)) expect(b - a + 1n).toBeLessThanOrEqual(1000n);
  });
});
