import { isDeepStrictEqual } from "node:util";
import { getAddress, type Hex } from "viem";
import { hashVaultMessage, networkOf, vaultDomain, type FacilitatorRequest } from "@clawdford/x402";
import type { Deployment } from "@clawdford/aevum";

/** Decimal-string fields become bigint, hex fields stay as they are. */
const big = <T extends Record<string, string>>(o: T) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, /^\d+$/.test(v) ? BigInt(v) : v])) as {
    [K in keyof T]: T[K] extends Hex ? Hex : bigint;
  };

export type VaultCall =
  | { functionName: "payExact"; args: readonly unknown[] }
  | { functionName: "openChannel"; args: readonly unknown[] }
  | { functionName: "topUp"; args: readonly unknown[] }
  | { functionName: "createTask"; args: readonly unknown[] }
  | { functionName: "claim"; args: readonly unknown[] }
  | { functionName: "requestCloseWithSig"; args: readonly unknown[] }
  | { functionName: "finalizeClose"; args: readonly unknown[] }
  | { functionName: "approveWithSig"; args: readonly unknown[] };

export interface Planned {
  call: VaultCall;
  /** Session the money comes from, for limits and payer lookup. 0 for top ups (looked up from the channel). */
  sessionId: bigint;
  channelId?: bigint;
  action: string;
  amount: string;
}

/**
 * Checks the request against this facilitator's chain and against itself (the buyer must have signed what the
 * seller asked for), then builds the vault call. Signatures, nonces, deadlines and caps are left to the contract
 * via eth_call. Returns a reason code string on failure.
 */
export function plan(req: FacilitatorRequest, d: Deployment): Planned | string {
  const { paymentPayload: p, paymentRequirements: r } = req;
  if (!isDeepStrictEqual(p.accepted, r)) return "requirements_mismatch";
  if (r.network !== networkOf(d.chainId)) return "unsupported_network";
  if (getAddress(r.asset) !== getAddress(d.tUSD8)) return "unsupported_asset";
  if (getAddress(r.extra.vault) !== getAddress(d.AgentVault)) return "wrong_vault";

  switch (p.accepted.scheme) {
    case "exact": {
      const { quote, quoteSig, stallId } = p.accepted.extra;
      const { intent, signature } = (p as Extract<typeof p, { accepted: { scheme: "exact" } }>).payload;
      if (quote.stallId !== stallId || quote.amount !== r.amount) return "quote_mismatch";
      if (hashVaultMessage(vaultDomain(d.chainId, d.AgentVault), "Quote", quote) !== intent.quoteHash) {
        return "intent_quote_mismatch";
      }
      return {
        call: { functionName: "payExact", args: [big(quote), quoteSig, big(intent), signature] },
        sessionId: BigInt(intent.sessionId),
        action: "pay",
        amount: quote.amount,
      };
    }
    case "batch-settlement": {
      const { extra } = p.accepted;
      const pl = (p as Extract<typeof p, { accepted: { scheme: "batch-settlement" } }>).payload;
      if (pl.action === "open") {
        const o = pl.open;
        if (o.stallId !== extra.stallId) return "stall_mismatch";
        if (BigInt(o.deposit) < BigInt(extra.minDeposit)) return "deposit_too_small";
        return {
          call: {
            functionName: "openChannel",
            args: [BigInt(o.sessionId), BigInt(o.stallId), BigInt(o.deposit), BigInt(o.validBefore), BigInt(o.nonce), pl.signature],
          },
          sessionId: BigInt(o.sessionId),
          action: "open",
          amount: o.deposit,
        };
      }
      if (pl.action === "topUp") {
        const t = pl.topUp;
        return {
          call: {
            functionName: "topUp",
            args: [BigInt(t.channelId), BigInt(t.amount), BigInt(t.validBefore), BigInt(t.nonce), pl.signature],
          },
          sessionId: 0n,
          channelId: BigInt(t.channelId),
          action: "topUp",
          amount: t.amount,
        };
      }
      return "voucher_goes_to_seller"; // vouchers are verified and claimed by the seller, not relayed here
    }
    case "escrow": {
      const { task, signature } = (p as Extract<typeof p, { accepted: { scheme: "escrow" } }>).payload;
      const { extra } = p.accepted;
      if (task.stallId !== extra.stallId || task.amount !== r.amount) return "task_mismatch";
      if (extra.specHash && extra.specHash !== task.specHash) return "spec_mismatch";
      const t = big(task);
      return {
        call: {
          functionName: "createTask",
          args: [t.sessionId, t.stallId, t.amount, t.specHash, t.deadline, t.validBefore, t.nonce, signature],
        },
        sessionId: t.sessionId,
        action: "task",
        amount: task.amount,
      };
    }
  }
}
