// Prints tQDAY and tUSD8 balances for every key in .env, plus the RPC's chain id and head block.
// Usage: pnpm check-setup   (reads ../../.env if present)
import { createPublicClient, erc20Abi, formatUnits, http, isHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { aevum, TUSD8_ADDRESS, TUSD8_DECIMALS } from "./chains.js";

const ROLE_KEYS = ["DEPLOYER_PRIVATE_KEY", "FACILITATOR_PRIVATE_KEY", "SELLER_PRIVATE_KEY", "OWNER_PRIVATE_KEY"];
// Well known anvil test keys. Funds sent to them on a public chain get swept by bots.
const ANVIL_KEY_PREFIX = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478";

try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
} catch {
  // no .env: fall back to the process environment
}

const rpc = process.env.AEVUM_RPC_URL ?? aevum.rpcUrls.default.http[0];
const client = createPublicClient({ chain: aevum, transport: http(rpc) });

const chainId = await client.getChainId();
const head = await client.getBlockNumber();
console.log(`RPC ${rpc}\nchain id ${chainId} (expected ${aevum.id}), head block ${head}`);
if (chainId !== aevum.id) {
  console.error("Wrong chain id. Check AEVUM_RPC_URL.");
  process.exitCode = 1;
}

let found = 0;
for (const role of ROLE_KEYS) {
  const key = process.env[role];
  if (!key) continue;
  if (!isHex(key) || key.length !== 66) {
    console.error(`${role}: not a 32-byte hex private key`);
    process.exitCode = 1;
    continue;
  }
  if (key.toLowerCase().startsWith(ANVIL_KEY_PREFIX)) console.warn(`${role}: WARNING, this is a public anvil key`);
  const { address } = privateKeyToAccount(key as Hex);
  const [gas, usd] = await Promise.all([
    client.getBalance({ address }),
    client.readContract({ address: TUSD8_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
  ]);
  found++;
  console.log(`${role.padEnd(24)} ${address}  ${formatUnits(gas, 18)} tQDAY  ${formatUnits(usd, TUSD8_DECIMALS)} tUSD8`);
}

if (!found) console.log("No keys in .env yet. Copy .env.example to .env and fill in the role keys.");
