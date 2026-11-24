import type { PublicClient } from "viem";

/** Aevum's RPC rejects eth_getLogs ranges wider than 1,000 blocks. */
export const MAX_LOG_RANGE = 1000n;

/** Split [from, to] into inclusive ranges of at most `size` blocks. */
export function blockRanges(from: bigint, to: bigint, size: bigint = MAX_LOG_RANGE): Array<[bigint, bigint]> {
  if (size <= 0n) throw new Error("size must be positive");
  const out: Array<[bigint, bigint]> = [];
  for (let start = from; start <= to; start += size) {
    const end = start + size - 1n;
    out.push([start, end < to ? end : to]);
  }
  return out;
}

type GetLogsArgs = Omit<Parameters<PublicClient["getLogs"]>[0] & object, "fromBlock" | "toBlock" | "blockHash">;

/**
 * eth_getLogs over any range, in sequential 1,000-block chunks.
 * Always pass the stored deploy block as `fromBlock`; never scan from genesis.
 */
export async function getLogsChunked(
  client: PublicClient,
  args: GetLogsArgs & { fromBlock: bigint; toBlock?: bigint; chunkSize?: bigint },
) {
  const { fromBlock, toBlock, chunkSize, ...rest } = args;
  const end = toBlock ?? (await client.getBlockNumber());
  const logs = [];
  for (const [from, to] of blockRanges(fromBlock, end, chunkSize)) {
    logs.push(...(await client.getLogs({ ...(rest as object), fromBlock: from, toBlock: to } as never)));
  }
  return logs;
}
