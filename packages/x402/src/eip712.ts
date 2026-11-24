import { hashTypedData, type Address, type TypedDataDefinition } from "viem";

/** EIP-712 domain of AgentVault (`EIP712("ClawdfordVault", "1")` in VaultBase). */
export function vaultDomain(chainId: number, vault: Address) {
  return { name: "ClawdfordVault", version: "1", chainId, verifyingContract: vault } as const;
}
export type VaultDomain = ReturnType<typeof vaultDomain>;

/** Must match the *_TYPEHASH strings in contracts/src/vault/*.sol (a test reads the sources to check). */
export const vaultTypes = {
  Quote: [
    { name: "stallId", type: "uint256" },
    { name: "amount", type: "uint256" },
    { name: "resourceHash", type: "bytes32" },
    { name: "buyerSession", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "quoteNonce", type: "bytes32" },
  ],
  PaymentIntent: [
    { name: "quoteHash", type: "bytes32" },
    { name: "sessionId", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
  OpenChannel: [
    { name: "sessionId", type: "uint256" },
    { name: "stallId", type: "uint256" },
    { name: "deposit", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
  TopUp: [
    { name: "channelId", type: "uint256" },
    { name: "amount", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
  Voucher: [
    { name: "channelId", type: "uint256" },
    { name: "cumulativeAmount", type: "uint256" },
  ],
  CloseChannel: [{ name: "channelId", type: "uint256" }],
  CreateTask: [
    { name: "sessionId", type: "uint256" },
    { name: "stallId", type: "uint256" },
    { name: "amount", type: "uint256" },
    { name: "specHash", type: "bytes32" },
    { name: "deadline", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
  ApproveTask: [{ name: "taskId", type: "uint256" }],
} as const;
export type VaultPrimaryType = keyof typeof vaultTypes;

/**
 * Full typed-data object for a wire message (uint256 fields as decimal strings). Pass it to viem's
 * `signTypedData` (wallet or local account) or `hashTypedData`.
 */
export function vaultTypedData(
  domain: VaultDomain,
  primaryType: VaultPrimaryType,
  wire: Record<string, string>,
): TypedDataDefinition {
  const message = Object.fromEntries(
    vaultTypes[primaryType].map(({ name, type }) => {
      const v = wire[name];
      if (v === undefined) throw new Error(`${primaryType}.${name} missing`);
      return [name, type === "uint256" ? BigInt(v) : v];
    }),
  );
  return { domain, types: { [primaryType]: vaultTypes[primaryType] }, primaryType, message } as unknown as TypedDataDefinition;
}

export function hashVaultMessage(domain: VaultDomain, primaryType: VaultPrimaryType, wire: Record<string, string>) {
  return hashTypedData(vaultTypedData(domain, primaryType, wire));
}
