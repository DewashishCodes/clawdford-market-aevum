// Owner actions from the command line, for headless runs on Aevum where the web app needs an injected wallet.
// Reads OWNER_PRIVATE_KEY from the repo .env (this script is the owner, not the agent; the MCP server never reads .env).
// Usage (from mcp/):
//   pnpm owner deposit <tUSD8>          gasless deposit: signs EIP-3009, the facilitator submits it
//   pnpm owner session [--approve] [--per-payment <tUSD8>]
//                                       workflow 1 caps, 0.005 tQDAY gas for the agent; writes aevum-mcp-<sessionId>.json
//   pnpm owner revoke <sessionId>       kill switch
//   pnpm owner status                   wallet, vault balance and sessions
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPublicClient, createWalletClient, formatUnits, http, parseEther, parseEventLogs, parseUnits, toHex, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { agentVaultAbi, chainById, loadDeployment, mockTUSD8Abi, TUSD8_EIP712 } from "@clawdford/aevum";

process.loadEnvFile(fileURLToPath(new URL("../../.env", import.meta.url)));
const chainId = Number(process.env.CHAIN_ID || "44005");
const rpc = process.env.RPC_URL || chainById(chainId).rpcUrls.default.http[0]!;
const facilitator = process.env.FACILITATOR_URL || "http://127.0.0.1:4020";
const chain = { ...chainById(chainId), rpcUrls: { default: { http: [rpc] } } };
const owner = privateKeyToAccount(process.env.OWNER_PRIVATE_KEY as Hex);
const pub = createPublicClient({ chain, transport: http(rpc) });
const wallet = createWalletClient({ chain, transport: http(rpc), account: owner });
const d = loadDeployment(chainId);
const explorer = chainId === 44005 ? "https://explorer-test.qday.info/tx/" : "";
const tusd = (x: bigint) => `${formatUnits(x, 6)} tUSD8`;

async function send(fn: string, args: unknown[]) {
  const { request } = await pub.simulateContract({ account: owner, address: d.AgentVault, abi: agentVaultAbi, functionName: fn, args } as never);
  const hash = await wallet.writeContract({ ...(request as object), type: "legacy" } as never);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${fn} reverted: ${hash}`);
  console.log(`${fn.padEnd(14)} ${explorer}${hash}`);
  return receipt;
}

const [cmd, arg] = process.argv.slice(2);
const flag = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };

if (cmd === "deposit") {
  const value = parseUnits(arg ?? "1", 6);
  const auth = { from: owner.address, to: d.AgentVault, value, validAfter: 0n, validBefore: BigInt(Math.floor(Date.now() / 1000) + 3600), nonce: toHex(randomBytes(32)) };
  const signature = await owner.signTypedData({
    domain: { ...TUSD8_EIP712, chainId, verifyingContract: d.tUSD8 },
    types: { ReceiveWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
    primaryType: "ReceiveWithAuthorization",
    message: auth,
  });
  const res = await fetch(`${facilitator}/deposit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ from: auth.from, amount: value.toString(), validAfter: "0", validBefore: auth.validBefore.toString(), nonce: auth.nonce, signature }),
  });
  const body = (await res.json()) as { success: boolean; transaction?: string; errorReason?: string };
  if (!body.success) throw new Error(`deposit refused: ${body.errorReason}`);
  console.log(`deposit        ${explorer}${body.transaction} (${tusd(value)}, gas paid by the facilitator)`);
} else if (cmd === "session") {
  const agentKey = generatePrivateKey();
  const agent = privateKeyToAccount(agentKey).address;
  const receipt = await send("createSession", [
    // Workflow 1: 0.2 per payment, 1.0 a day, 2.0 total, 2 hours, every category but `tool`.
    { agentKey: agent, perPaymentCap: parseUnits(flag("--per-payment") ?? "0.2", 6), dailyCap: 1_000_000n, totalCap: 2_000_000n, expiry: BigInt(Math.floor(Date.now() / 1000) + 7200), categoryMask: (0xffffffff & ~(1 << 2)) >>> 0, agentCanApprove: process.argv.includes("--approve") },
  ]);
  const [ev] = parseEventLogs({ abi: agentVaultAbi, logs: receipt.logs, eventName: "SessionCreated" });
  const sessionId = ev!.args.sessionId.toString();
  const gas = await wallet.sendTransaction({ to: agent, value: parseEther("0.005"), type: "legacy" } as never);
  await pub.waitForTransactionReceipt({ hash: gas });
  console.log(`agent gas      ${explorer}${gas}`);

  const mcpDir = fileURLToPath(new URL("..", import.meta.url));
  const tsx = pathToFileURL(createRequire(join(mcpDir, "package.json")).resolve("tsx/esm")).href;
  const env = { CHAIN_ID: String(chainId), RPC_URL: rpc, SESSION_KEY: agentKey, SESSION_ID: sessionId, FACILITATOR_URL: facilitator, BUDGET_PER_CALL: "0.2", SKILLS_DIR: join(mcpDir, ".aevum-skills"), STATE_DIR: join(mcpDir, ".aevum-state") };
  const file = join(mcpDir, `${chainId === 44005 ? "aevum" : `chain-${chainId}`}-mcp-${sessionId}.json`);
  writeFileSync(file, `${JSON.stringify({ mcpServers: { "clawdford-market": { command: process.execPath, args: ["--import", tsx, join(mcpDir, "src", "index.ts")], env } } }, null, 2)}\n`);
  console.log(`session ${sessionId} for agent ${agent}; MCP config (holds the session key, git-ignored): ${file}`);
} else if (cmd === "revoke") {
  await send("revokeSession", [BigInt(arg!)]);
} else if (cmd === "status") {
  const [gas, inWallet, inVault] = await Promise.all([
    pub.getBalance({ address: owner.address }),
    pub.readContract({ address: d.tUSD8, abi: mockTUSD8Abi, functionName: "balanceOf", args: [owner.address] }),
    pub.readContract({ address: d.AgentVault, abi: agentVaultAbi, functionName: "balanceOf", args: [owner.address] }),
  ]);
  console.log(`owner ${owner.address}: ${formatUnits(gas, 18)} tQDAY, wallet ${tusd(inWallet)}, vault ${tusd(inVault)}`);
} else {
  console.error("usage: pnpm owner deposit <tUSD8> | session [--approve] [--per-payment <tUSD8>] | revoke <sessionId> | status");
  process.exit(1);
}
