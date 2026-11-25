// Registers the demo identities and stalls on CHAIN_ID and writes deployments/stalls-<chainId>.json.
import { existsSync, writeFileSync } from "node:fs";
import { baseUrl, chainId, env, rpcUrl, sellerKey, stallsFile } from "./env.js";
import { seedStalls } from "./seed.js";

if (existsSync(stallsFile) && !process.argv.includes("--force")) {
  console.error(`${stallsFile} exists; stalls are already seeded on chain ${chainId}. Pass --force to seed a second set (new domains needed).`);
  process.exit(1);
}

const result = await seedStalls({
  chainId,
  rpcUrl,
  sellerKey: sellerKey(),
  baseUrl,
  domains: { demo: env("SEED_DOMAIN_DEMO", "demo.clawdford.market"), shady: env("SEED_DOMAIN_SHADY", "shady.clawdford.market") },
  log: console.log,
});
writeFileSync(stallsFile, `${JSON.stringify(result, null, 2)}\n`);
console.log(`wrote ${stallsFile}`);
