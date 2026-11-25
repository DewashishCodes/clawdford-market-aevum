import { parseEventLogs, type Abi, type PublicClient } from "viem";
import { agentVaultAbi, identityRegistryAbi, reputationRegistryAbi, stallRegistryAbi } from "@clawdford/aevum/abis";
import { blockRanges, type Deployment } from "@clawdford/aevum";

export interface ChainEvent {
  name: string;
  args: Record<string, unknown>;
  contract: "vault" | "stalls" | "identity" | "reputation";
  blockNumber: bigint;
  txHash: `0x${string}`;
  logIndex: number;
}

const ABI = [...agentVaultAbi, ...stallRegistryAbi, ...identityRegistryAbi, ...reputationRegistryAbi] as Abi;
const PARALLEL = 6;

/**
 * Every protocol event from the deploy block on, in memory, caught up at most every `minIntervalMs`.
 * shortcut: in memory per server process, so a cold start rescans from the deploy block; move to SQLite if starts get slow.
 */
export function createIndexer(pub: PublicClient, d: Deployment, minIntervalMs = 2_000) {
  const events: ChainEvent[] = [];
  const contractOf = new Map<string, ChainEvent["contract"]>([
    [d.AgentVault.toLowerCase(), "vault"],
    [d.StallRegistry.toLowerCase(), "stalls"],
    [d.IdentityRegistry.toLowerCase(), "identity"],
    [d.ReputationRegistry.toLowerCase(), "reputation"],
  ]);
  let next = BigInt(d.deployBlock);
  let syncedAt = 0;
  let running: Promise<void> | undefined;
  const times = new Map<bigint, number>();

  async function catchUp() {
    const head = await pub.getBlockNumber();
    if (head < next) return;
    const ranges = blockRanges(next, head);
    for (let i = 0; i < ranges.length; i += PARALLEL) {
      const batch = await Promise.all(
        ranges.slice(i, i + PARALLEL).map(([fromBlock, toBlock]) => pub.getLogs({ address: [...contractOf.keys()] as `0x${string}`[], fromBlock, toBlock })),
      );
      for (const log of parseEventLogs({ abi: ABI, logs: batch.flat() })) {
        events.push({
          name: log.eventName,
          args: log.args as Record<string, unknown>,
          contract: contractOf.get(log.address.toLowerCase())!,
          blockNumber: log.blockNumber,
          txHash: log.transactionHash,
          logIndex: log.logIndex,
        });
      }
    }
    next = head + 1n;
  }

  /** Brings the cache up to date (shared by concurrent callers) and returns all events, oldest first. */
  async function sync() {
    if (Date.now() - syncedAt >= minIntervalMs) {
      running ??= catchUp().finally(() => {
        syncedAt = Date.now();
        running = undefined;
      });
      await running;
    }
    return events;
  }

  /** Block timestamp in ms, cached. */
  async function timeOf(block: bigint) {
    if (!times.has(block)) times.set(block, Number((await pub.getBlock({ blockNumber: block })).timestamp) * 1000);
    return times.get(block)!;
  }

  return { sync, timeOf };
}

export type Indexer = ReturnType<typeof createIndexer>;
