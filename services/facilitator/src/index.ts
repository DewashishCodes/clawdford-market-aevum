import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, parseEther, type Hex } from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { chainById, loadDeployment } from "@clawdford/aevum";
import { createApp } from "./app.js";
import { Rails } from "./rails.js";

try {
  process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
} catch {
  // no root .env: rely on the real environment
}

const env = (name: string, fallback?: string) => {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`${name} is not set`);
  return v;
};

const chainId = Number(env("CHAIN_ID", "44005"));
const chain = chainById(chainId);
const rpc = process.env.RPC_URL ?? chain.rpcUrls.default.http[0];
const account = privateKeyToAccount(env("FACILITATOR_PRIVATE_KEY") as Hex);

// Anvil's public test keys get swept by bots on a real chain.
const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";
const anvilAddresses = Array.from({ length: 10 }, (_, i) => mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: i }).address);
if (chainId === 44005 && anvilAddresses.includes(account.address)) {
  throw new Error("refusing an anvil default key on Aevum; set FACILITATOR_PRIVATE_KEY to a real key");
}

const transport = http(rpc);
const publicClient = createPublicClient({ chain, transport });
const walletClient = createWalletClient({ chain, transport, account });
const deployment = loadDeployment(chainId);
const rails = new Rails(env("FACILITATOR_DB", "facilitator.sqlite"), {
  perIpPerDay: Number(env("LIMIT_PER_IP_DAY", "500")),
  perSessionPerDay: Number(env("LIMIT_PER_SESSION_DAY", "1000")),
  perDay: Number(env("LIMIT_PER_DAY", "10000")),
});
const lowBalanceWei = parseEther(env("LOW_BALANCE_TQDAY", "0.05"));

const app = createApp({ publicClient, walletClient, deployment, rails, lowBalanceWei });
const port = Number(env("FACILITATOR_PORT", "4020"));
app.listen(port, async () => {
  const wei = await publicClient.getBalance({ address: account.address });
  console.log(`facilitator ${account.address} on chain ${chainId} (${rpc}), vault ${deployment.AgentVault}`);
  console.log(`listening on :${port}, gas balance ${wei} wei${wei < lowBalanceWei ? " (LOW)" : ""}`);
});
