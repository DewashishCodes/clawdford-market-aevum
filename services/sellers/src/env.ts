import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Hex } from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import type { SeedResult } from "./seed.js";

try {
  process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
} catch {
  // no root .env: rely on the real environment
}

export const env = (name: string, fallback?: string) => {
  const v = process.env[name] || fallback;
  if (v === undefined) throw new Error(`${name} is not set`);
  return v;
};

export const chainId = Number(env("CHAIN_ID", "44005"));
export const rpcUrl = process.env.RPC_URL || undefined;
export const port = Number(env("SELLERS_PORT", "4030"));
export const baseUrl = env("SELLERS_PUBLIC_URL", `http://127.0.0.1:${port}`).replace(/\/$/, "");
export const stallsFile = fileURLToPath(new URL(`../../../deployments/stalls-${chainId}.json`, import.meta.url));

export function sellerKey(): Hex {
  const key = env("SELLER_PRIVATE_KEY") as Hex;
  // Anvil's public test keys get swept by bots on a real chain.
  const anvil = Array.from({ length: 10 }, (_, i) => mnemonicToAccount("test test test test test test test test test test test junk", { addressIndex: i }).address);
  if (chainId === 44005 && anvil.includes(privateKeyToAccount(key).address)) throw new Error("refusing an anvil default key on Aevum; set SELLER_PRIVATE_KEY to a real key");
  return key;
}

export function readStalls(): SeedResult {
  if (!existsSync(stallsFile)) throw new Error(`${stallsFile} not found; run the seed script first (pnpm --filter @clawdford/sellers seed)`);
  return JSON.parse(readFileSync(stallsFile, "utf8")) as SeedResult;
}
