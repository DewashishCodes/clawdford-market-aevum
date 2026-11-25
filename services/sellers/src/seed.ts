import { createPublicClient, createWalletClient, http, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chainById, identityRegistryAbi, loadDeployment, mockTUSD8Abi, stallRegistryAbi, type Deployment } from "@clawdford/aevum";
import { CATALOG, CATEGORY, MODE, STALL_KEYS, type StallIds } from "./catalog.js";

export interface SeedConfig {
  chainId: number;
  rpcUrl?: string;
  deployment?: Deployment;
  sellerKey: Hex;
  /** Public URL of the sellers server. Agent cards, endpoints and metadata point here. */
  baseUrl: string;
  /** Identity domains; must be unused on chain. */
  domains?: { demo: string; shady: string };
  /** Stake per stall. Defaults to the registry's minStake. */
  stake?: bigint;
  log?: (msg: string) => void;
}

export interface SeedResult {
  chainId: number;
  baseUrl: string;
  identities: { demo: string; shady: string };
  stalls: Record<string, string>;
}

/** Registers the two identities and the eight demo stalls, staked, from the seller key (which pays gas and stake). */
export async function seedStalls(cfg: SeedConfig): Promise<SeedResult> {
  const base = chainById(cfg.chainId);
  const rpc = cfg.rpcUrl ?? base.rpcUrls.default.http[0];
  const chain = { ...base, rpcUrls: { default: { http: [rpc] } } };
  const pub = createPublicClient({ chain, transport: http(rpc) });
  const account = privateKeyToAccount(cfg.sellerKey);
  const wallet = createWalletClient({ chain, transport: http(rpc), account });
  const d = cfg.deployment ?? loadDeployment(cfg.chainId);
  const log = cfg.log ?? (() => {});

  async function send(address: Address, abi: Abi, functionName: string, args: unknown[]) {
    const { result, request } = await pub.simulateContract({ account, address, abi, functionName, args } as never);
    const hash = await wallet.writeContract({ ...(request as object), type: "legacy" } as never);
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${functionName} reverted (${hash})`);
    log(`${functionName} ${hash}`);
    return result as unknown;
  }

  const stake = cfg.stake ?? ((await pub.readContract({ address: d.StallRegistry, abi: stallRegistryAbi, functionName: "minStake" })) as bigint);
  const total = stake * BigInt(STALL_KEYS.length);
  const balance = (await pub.readContract({ address: d.tUSD8, abi: mockTUSD8Abi, functionName: "balanceOf", args: [account.address] })) as bigint;
  if (balance < total) throw new Error(`seller ${account.address} holds ${balance} tUSD8 base units, needs ${total} to stake ${STALL_KEYS.length} stalls`);

  const domains = cfg.domains ?? { demo: "demo.clawdford.market", shady: "shady.clawdford.market" };
  const card = { demo: `${cfg.baseUrl}/.well-known/agent-card.json`, shady: `${cfg.baseUrl}/shady/.well-known/agent-card.json` };
  const identities = {
    demo: (await send(d.IdentityRegistry, identityRegistryAbi as Abi, "register", [domains.demo, card.demo])) as bigint,
    shady: (await send(d.IdentityRegistry, identityRegistryAbi as Abi, "register", [domains.shady, card.shady])) as bigint,
  };
  await send(d.tUSD8, mockTUSD8Abi as Abi, "approve", [d.StallRegistry, total]);

  const stalls = {} as StallIds;
  for (const key of STALL_KEYS) {
    const s = CATALOG[key];
    stalls[key] = (await send(d.StallRegistry, stallRegistryAbi as Abi, "createStall", [
      {
        identityId: identities[s.identity],
        payee: account.address,
        quoteSigner: account.address,
        category: CATEGORY[s.category],
        mode: MODE[s.mode],
        unitPrice: s.unitPrice,
        unit: s.unit,
        endpoint: `${cfg.baseUrl}/s/${key}`,
        metadataURI: `${cfg.baseUrl}/catalog#${key}`,
        stake,
      },
    ])) as bigint;
    log(`stall ${stalls[key]}: ${s.name}`);
  }

  const str = (o: Record<string, bigint>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.toString()]));
  return { chainId: cfg.chainId, baseUrl: cfg.baseUrl, identities: str(identities) as SeedResult["identities"], stalls: str(stalls) };
}

export const stallIdsOf = (r: SeedResult) => Object.fromEntries(STALL_KEYS.map((k) => [k, BigInt(r.stalls[k]!)])) as StallIds;
