import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, http, type Hex, type PublicClient } from "viem";
import { chainById } from "@clawdford/aevum/chains";
import type { Deployment } from "@clawdford/aevum";
import { createIndexer, type Indexer } from "./indexer";

export interface WebConfig {
  chainId: number;
  rpcUrl: string;
  deployment: Deployment;
  facilitatorUrl: string;
  /** Local chains only: a key the browser uses instead of an injected wallet. */
  devWalletKey?: Hex;
}

export interface Ctx {
  cfg: WebConfig;
  pub: PublicClient;
  indexer: Indexer;
}

export function createCtx(cfg: WebConfig): Ctx {
  const base = chainById(cfg.chainId);
  const chain = { ...base, rpcUrls: { default: { http: [cfg.rpcUrl] } } };
  const pub = createPublicClient({ chain, transport: http(cfg.rpcUrl) }) as PublicClient;
  return { cfg, pub, indexer: createIndexer(pub, cfg.deployment) };
}

function configFromEnv(): WebConfig {
  const chainId = Number(process.env.CHAIN_ID ?? 44005);
  const dir = process.env.DEPLOYMENTS_DIR ?? join(process.cwd(), "..", "deployments");
  const deployment = JSON.parse(readFileSync(join(dir, `${chainId}.json`), "utf8")) as Deployment;
  const devWalletKey = process.env.DEV_WALLET_KEY as Hex | undefined;
  if (devWalletKey && chainId === 44005) throw new Error("DEV_WALLET_KEY is for local chains only; unset it for Aevum");
  return {
    chainId,
    rpcUrl: process.env.RPC_URL ?? chainById(chainId).rpcUrls.default.http[0],
    deployment,
    facilitatorUrl: (process.env.FACILITATOR_URL ?? "http://127.0.0.1:4020").replace(/\/$/, ""),
    devWalletKey,
  };
}

// One context per server process, so the indexer's cache survives between requests.
const g = globalThis as { __clawdfordCtx?: Ctx };
export const ctx = () => (g.__clawdfordCtx ??= createCtx(configFromEnv()));
