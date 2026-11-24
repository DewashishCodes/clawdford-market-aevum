// Test-only: a fresh chain with the protocol deployed, one stall per mode and a funded agent session.
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  type Account,
  type Address,
  type PrivateKeyAccount,
} from "viem";
import { generatePrivateKey, mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import {
  agentVaultAbi,
  chainById,
  identityRegistryAbi,
  loadDeployment,
  mockTUSD8Abi,
  stallRegistryAbi,
  type Deployment,
} from "@clawdford/aevum";

const MNEMONIC = "test test test test test test test test test test test junk";
const PK0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const at = (i: number) => mnemonicToAccount(MNEMONIC, { addressIndex: i });

/** Session caps used by every test chain (tUSD8 base units). */
export const SESSION = { perPaymentCap: 50_000n, dailyCap: 200_000n, totalCap: 300_000n };
/** On-chain unit prices of the test stalls. */
/** Channel close window on test chains (seconds). */
export const CHALLENGE_WINDOW = 5;
export const PRICES = { exact: 10_000n, stream: 1_000n, task: 30_000n, license: 50_000n };

function run(cmd: string, args: string[], cwd: string, env: Record<string, string>) {
  return new Promise<void>((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: "pipe" });
    let out = "";
    p.stdout.on("data", (b) => (out += b));
    p.stderr.on("data", (b) => (out += b));
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} failed:\n${out}`))));
  });
}

/**
 * Spawns anvil on `port` (a fork of Aevum with the real tUSD8 when `fork`), runs Deploy.s.sol, registers one stall
 * per mode for `seller` and opens a session for a fresh agent key. Two test chains on the same chain id must not
 * start at the same moment: both write deployments/<chainId>.json.
 */
export async function startChain(opts: { fork: boolean; port: number }) {
  const chainId = opts.fork ? 440050 : 31337;
  const rpc = `http://127.0.0.1:${opts.port}`;
  const chain = { ...chainById(chainId), rpcUrls: { default: { http: [rpc] } } };
  const pub = createPublicClient({ chain, transport: http(rpc) });
  const test = createTestClient({ chain, mode: "anvil", transport: http(rpc) });
  const wallet = (account: Account) => createWalletClient({ chain, transport: http(rpc), account });
  const agentKey = generatePrivateKey(); // the session key an agent (MCP server) would hold; no gas, only signs
  const accounts = {
    deployer: at(0),
    seller: at(1),
    owner: at(2),
    facilitator: at(3),
    agent: privateKeyToAccount(agentKey) as PrivateKeyAccount,
  };

  const forkArgs = opts.fork ? ["--fork-url", "https://rpc-test.qday.info", "--chain-id", "440050"] : [];
  const anvil: ChildProcess = spawn("anvil", ["--hardfork", "shanghai", "--port", String(opts.port), "--silent", ...forkArgs], {
    stdio: "ignore",
  });
  for (let i = 0; ; i++) {
    try {
      await pub.getChainId();
      break;
    } catch {
      if (i > 150) throw new Error("anvil did not start");
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  /** Simulate (to get the return value), send as a legacy tx, wait. */
  async function send(account: Account, address: Address, abi: readonly unknown[], functionName: string, args: unknown[]) {
    const { result, request } = await pub.simulateContract({ account, address, abi, functionName, args } as never);
    const hash = await wallet(account).writeContract({ ...(request as object), type: "legacy" } as never);
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${functionName} reverted`);
    return result as unknown;
  }

  const contracts = fileURLToPath(new URL("../../../contracts", import.meta.url));
  await run("forge", ["script", "script/Deploy.s.sol", "--rpc-url", rpc, "--broadcast", "--legacy"], contracts, {
    DEPLOYER_PRIVATE_KEY: PK0,
    CHALLENGE_WINDOW: String(CHALLENGE_WINDOW), // short, so tests barely move chain time away from the real clock
  });
  const d: Deployment = loadDeployment(chainId);
  const { seller, owner, agent, deployer } = accounts;

  // tUSD8: 1.0 stake budget for the seller, 0.5 for the owner's vault deposit
  const grants: [Address, bigint][] = [
    [seller.address, 1_000_000n],
    [owner.address, 500_000n],
  ];
  if (opts.fork) {
    const rich = loadDeployment(44005).deployer; // holds real tUSD8 on Aevum
    await test.impersonateAccount({ address: rich });
    await test.setBalance({ address: rich, value: 10n ** 18n });
    const erc20 = createWalletClient({ chain, transport: http(rpc), account: rich });
    for (const [to, amount] of grants) {
      const hash = await erc20.writeContract({ address: d.tUSD8, abi: mockTUSD8Abi, functionName: "transfer", args: [to, amount], type: "legacy" });
      await pub.waitForTransactionReceipt({ hash });
    }
  } else {
    for (const [to, amount] of grants) await send(deployer, d.tUSD8, mockTUSD8Abi, "mint", [to, amount]);
  }

  const identityId = (await send(seller, d.IdentityRegistry, identityRegistryAbi, "register", ["stalls.test", "ipfs://card"])) as bigint;
  await send(seller, d.tUSD8, mockTUSD8Abi, "approve", [d.StallRegistry, 1_000_000n]);
  const stall = { exact: 0n, stream: 0n, task: 0n, license: 0n };
  for (const [key, mode] of [["exact", 0], ["stream", 1], ["task", 2], ["license", 3]] as const) {
    stall[key] = (await send(seller, d.StallRegistry, stallRegistryAbi, "createStall", [
      { identityId, payee: seller.address, quoteSigner: seller.address, category: 0, mode, unitPrice: PRICES[key], unit: "call", endpoint: "http://stall.local", metadataURI: "ipfs://meta", stake: 250_000n },
    ])) as bigint;
  }

  await send(owner, d.tUSD8, mockTUSD8Abi, "approve", [d.AgentVault, 500_000n]);
  await send(owner, d.AgentVault, agentVaultAbi, "deposit", [500_000n]);
  const now = async () => (await pub.getBlock()).timestamp;
  const sessionId = (await send(owner, d.AgentVault, agentVaultAbi, "createSession", [
    { agentKey: agent.address, ...SESSION, expiry: (await now()) + 86_400n, categoryMask: 1, agentCanApprove: false },
  ])) as bigint;

  return {
    chainId,
    rpc,
    chain,
    pub,
    wallet,
    accounts,
    d,
    stall,
    sessionId,
    identityId,
    agentKey,
    send,
    now,
    balanceOf: async (who: Address) =>
      (await pub.readContract({ address: d.tUSD8, abi: mockTUSD8Abi, functionName: "balanceOf", args: [who] })) as bigint,
    /** Move chain time forward and mine a block. */
    warp: async (seconds: number) => {
      await test.increaseTime({ seconds });
      await test.mine({ blocks: 1 });
    },
    stop: () => anvil.kill(),
  };
}

export type TestChain = Awaited<ReturnType<typeof startChain>>;
