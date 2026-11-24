#!/usr/bin/env node
// Scans compiled runtime bytecode for opcodes Aevum's Shanghai EVM does not support.
// Cancun code deploys fine on Aevum and then reverts with "invalid opcode", so we catch it at build time.
// Written fresh for this repo (not taken from the Aevum Starter Kit).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const FORBIDDEN = {
  0x49: "BLOBHASH",
  0x4a: "BLOBBASEFEE",
  0x5c: "TLOAD",
  0x5d: "TSTORE",
  0x5e: "MCOPY",
};

/** Strip the solc CBOR metadata tail: its length is stored in the last two bytes. */
export function stripMetadata(bytes) {
  if (bytes.length < 2) return bytes;
  const len = (bytes[bytes.length - 2] << 8) | bytes[bytes.length - 1];
  return len + 2 <= bytes.length ? bytes.subarray(0, bytes.length - len - 2) : bytes;
}

/** Walk opcodes (skipping PUSH data) and return every forbidden opcode with its offset. */
export function scan(hex) {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = stripMetadata(Buffer.from(clean, "hex"));
  const hits = [];
  for (let pc = 0; pc < bytes.length; pc++) {
    const op = bytes[pc];
    if (FORBIDDEN[op]) hits.push({ pc, op: FORBIDDEN[op] });
    if (op >= 0x60 && op <= 0x7f) pc += op - 0x5f; // PUSH1..PUSH32 immediate data
  }
  return hits;
}

function* artifacts(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "build-info") continue;
      yield* artifacts(p);
    } else if (name.endsWith(".json")) yield p;
  }
}

function main() {
  const outDir = process.argv[2] ?? "contracts/out";
  const only = (process.env.SHANGHAI_SCOPE ?? "src/").split("\\").join("/");
  if (!existsSync(outDir)) {
    // forge writes no out/ dir when src/ is empty; anything else means forge build was skipped.
    console.warn(`warn: ${outDir} not found, nothing to check (run forge build if contracts exist)`);
    return;
  }
  let checked = 0;
  let failed = 0;
  for (const file of artifacts(outDir)) {
    const art = JSON.parse(readFileSync(file, "utf8"));
    const source = Object.keys(art.metadata?.settings?.compilationTarget ?? {})[0] ?? "";
    if (!source.startsWith(only)) continue; // tests and forge-std are never deployed
    const code = art.deployedBytecode?.object;
    if (!code || code === "0x") continue;
    checked++;
    const hits = scan(code);
    if (hits.length) {
      failed++;
      console.error(`FAIL ${file}: ${hits.map((h) => `${h.op}@${h.pc}`).join(", ")}`);
    }
  }
  if (failed) {
    console.error(`${failed} of ${checked} contracts use Cancun opcodes. Aevum will revert them.`);
    process.exit(1);
  }
  console.log(`ok: ${checked} contracts are Shanghai safe`);
}

if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === process.argv[1].toLowerCase()) main();
