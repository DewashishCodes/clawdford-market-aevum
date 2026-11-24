import { defineChain } from "viem";

/** Aevum test token (6 decimals, EIP-2612 permit + EIP-3009). */
export const TUSD8_ADDRESS = "0x456569838f1d43009A91ebA4263147Afd7233483" as const;
export const TUSD8_DECIMALS = 6;
/** EIP-712 domain the real tUSD8 uses for permit and 3009 signatures. */
export const TUSD8_EIP712 = { name: "tUSD8", version: "2" } as const;

export const AEVUM_RPC_URL = "https://rpc-test.qday.info";
export const AEVUM_EXPLORER_URL = "https://explorer-test.qday.info";

/** QDay Aevum testnet. Shanghai EVM, legacy transactions only, HTTPS RPC (no WebSocket). */
export const aevum = defineChain({
  id: 44005,
  name: "QDay Aevum Testnet",
  nativeCurrency: { name: "tQDAY", symbol: "tQDAY", decimals: 18 },
  rpcUrls: { default: { http: [AEVUM_RPC_URL] } },
  blockExplorers: { default: { name: "Aevum Explorer", url: AEVUM_EXPLORER_URL } },
  testnet: true,
});

/** Local anvil fork of Aevum (`make fork`). Different chain ID so signatures never replay on the real chain. */
export const aevumFork = defineChain({
  id: 440050,
  name: "Aevum Fork (local)",
  nativeCurrency: { name: "tQDAY", symbol: "tQDAY", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
  testnet: true,
});

/** Plain local anvil (`make anvil`), used with MockTUSD8. */
export const anvilLocal = defineChain({
  id: 31337,
  name: "Anvil (local)",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
  testnet: true,
});

export const chains = { [aevum.id]: aevum, [aevumFork.id]: aevumFork, [anvilLocal.id]: anvilLocal } as const;
export type SupportedChainId = keyof typeof chains;

export function chainById(id: number) {
  const chain = chains[id as SupportedChainId];
  if (!chain) throw new Error(`Unsupported chain id ${id}`);
  return chain;
}

export function explorerTx(hash: string) {
  return `${AEVUM_EXPLORER_URL}/tx/${hash}`;
}

export function explorerAddress(address: string) {
  return `${AEVUM_EXPLORER_URL}/address/${address}`;
}
