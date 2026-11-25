import { stallRegistryAbi } from "@clawdford/aevum/abis";
import { chainById } from "@clawdford/aevum/chains";
import type { PublicConfig } from "../wallet";
import { ctx } from "./ctx";

/** What the browser may know: chain, public RPC, addresses, and the dev key on local chains only. */
export async function publicConfig(): Promise<PublicConfig> {
  const { cfg, pub } = ctx();
  const d = cfg.deployment;
  const chain = chainById(cfg.chainId);
  const minStake = await pub.readContract({ address: d.StallRegistry, abi: stallRegistryAbi, functionName: "minStake" }).catch(() => 250_000n);
  return {
    chainId: cfg.chainId,
    chainName: chain.name,
    // The browser talks to the public RPC; the server may use a private one.
    rpcUrl: process.env.PUBLIC_RPC_URL ?? cfg.rpcUrl,
    explorer: chain.blockExplorers?.default.url,
    contracts: { AgentVault: d.AgentVault, StallRegistry: d.StallRegistry, IdentityRegistry: d.IdentityRegistry, ReputationRegistry: d.ReputationRegistry, tUSD8: d.tUSD8 },
    minStake: minStake.toString(),
    facilitatorUrl: process.env.PUBLIC_FACILITATOR_URL ?? cfg.facilitatorUrl,
    devWalletKey: cfg.devWalletKey,
  };
}
