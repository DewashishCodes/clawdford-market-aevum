// Points the seeded stalls' metadata and the identities' agent cards at static copies (e.g. market/<chainId>/ in the
// GitHub repo, served by raw.githubusercontent.com), so the web app and agents can read names and confirm payees
// without the sellers server being public. Endpoints, payees and quote signers stay as they are.
// Usage: META_BASE=https://raw.githubusercontent.com/<owner>/<repo>/main/market/44005 pnpm --filter @clawdford/sellers repoint
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chainById, identityRegistryAbi, loadDeployment, stallRegistryAbi } from "@clawdford/aevum";
import { chainId, env, readStalls, rpcUrl, sellerKey } from "./env.js";

const base = env("META_BASE").replace(/\/$/, "");
if (!/^https:\/\//.test(base)) throw new Error("META_BASE must be an https URL");
const files = { catalog: `${base}/catalog.json`, demo: `${base}/agent-card.json`, shady: `${base}/shady-agent-card.json` };

// The copies must be live before the chain points at them.
for (const url of Object.values(files)) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} answered ${res.status}; push the files first`);
  await res.json();
}

const chain = chainById(chainId);
const rpc = rpcUrl ?? chain.rpcUrls.default.http[0];
const account = privateKeyToAccount(sellerKey());
const pub = createPublicClient({ chain, transport: http(rpc) });
const wallet = createWalletClient({ chain, transport: http(rpc), account });
const d = loadDeployment(chainId);
const seeded = readStalls();
const explorer = chainId === 44005 ? "https://explorer-test.qday.info/tx/" : "";

async function send(address: `0x${string}`, abi: typeof stallRegistryAbi | typeof identityRegistryAbi, functionName: string, args: unknown[], label: string) {
  const { request } = await pub.simulateContract({ account, address, abi, functionName, args } as never);
  const hash = await wallet.writeContract({ ...(request as object), type: "legacy" } as never);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label} reverted: ${hash}`);
  console.log(`${label.padEnd(28)} ${explorer}${hash}`);
}

for (const [key, id] of Object.entries(seeded.stalls)) {
  const s = await pub.readContract({ address: d.StallRegistry, abi: stallRegistryAbi, functionName: "getStall", args: [BigInt(id)] });
  const metadataURI = `${files.catalog}#${key}`;
  if (s.metadataURI === metadataURI) continue;
  await send(d.StallRegistry, stallRegistryAbi, "updateStall", [BigInt(id), s.payee, s.quoteSigner, s.endpoint, metadataURI], `stall ${id} ${key}`);
}
for (const [who, id] of Object.entries(seeded.identities) as ["demo" | "shady", string][]) {
  const i = await pub.readContract({ address: d.IdentityRegistry, abi: identityRegistryAbi, functionName: "getIdentity", args: [BigInt(id)] });
  if (i.agentCardURI === files[who]) continue;
  await send(d.IdentityRegistry, identityRegistryAbi, "update", [BigInt(id), files[who]], `identity ${id} ${who} card`);
}
console.log("done");
