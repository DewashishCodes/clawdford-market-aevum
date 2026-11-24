import { createPublicClient, http } from "viem";
import { chainById, loadDeployment, type Deployment } from "@clawdford/aevum";

export interface ChainConfig {
  chainId: number;
  /** Defaults to the chain's public RPC. */
  rpcUrl?: string;
  /** Defaults to deployments/<chainId>.json. */
  deployment?: Deployment;
}

export function connect(cfg: ChainConfig) {
  const base = chainById(cfg.chainId);
  const rpc = cfg.rpcUrl ?? base.rpcUrls.default.http[0];
  const chain = { ...base, rpcUrls: { default: { http: [rpc] } } };
  return {
    chain,
    transport: http(rpc),
    publicClient: createPublicClient({ chain, transport: http(rpc) }),
    deployment: cfg.deployment ?? loadDeployment(cfg.chainId),
  };
}

export async function postJson<T>(url: string, body: unknown, f: typeof fetch = fetch): Promise<T> {
  const res = await f(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return (await res.json()) as T;
}
