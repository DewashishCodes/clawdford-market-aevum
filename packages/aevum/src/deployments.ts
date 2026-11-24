import { readFileSync } from "node:fs";
import type { Address } from "viem";

/** Shape of deployments/<chainId>.json written by contracts/script/Deploy.s.sol. */
export interface Deployment {
  chainId: number;
  deployBlock: number;
  deployer: Address;
  treasury: Address;
  arbiter: Address;
  feeBps: number;
  tUSD8: Address;
  IdentityRegistry: Address;
  StallRegistry: Address;
  AgentVault: Address;
  ReputationRegistry: Address;
}

/** Reads deployments/<chainId>.json from the repo root. Local chains (31337, 440050) exist only after a local deploy. */
export function loadDeployment(chainId: number): Deployment {
  const url = new URL(`../../../deployments/${chainId}.json`, import.meta.url);
  try {
    return JSON.parse(readFileSync(url, "utf8")) as Deployment;
  } catch {
    throw new Error(`No deployment for chain ${chainId}; run the deploy script first`);
  }
}
