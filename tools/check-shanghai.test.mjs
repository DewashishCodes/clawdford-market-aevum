import { test } from "node:test";
import assert from "node:assert/strict";
import { scan, stripMetadata } from "./check-shanghai.mjs";

test("flags MCOPY and TSTORE as opcodes", () => {
  // PUSH1 0 PUSH1 0 MCOPY TSTORE STOP
  assert.deepEqual(scan("0x600060005e5d00").map((h) => h.op), ["MCOPY", "TSTORE"]);
});

test("ignores forbidden bytes inside PUSH data", () => {
  // PUSH2 0x5e5d STOP
  assert.deepEqual(scan("0x615e5d00"), []);
});

test("ignores the metadata tail", () => {
  // STOP, then 3 metadata bytes 5e5c49, then length 0x0003
  assert.equal(stripMetadata(Buffer.from("005e5c490003", "hex")).length, 1);
  assert.deepEqual(scan("0x005e5c490003"), []);
});
