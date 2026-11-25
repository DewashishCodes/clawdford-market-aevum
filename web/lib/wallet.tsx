"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  custom,
  http,
  toHex,
  type Abi,
  type Address,
  type EIP1193Provider,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chainById } from "@clawdford/aevum/chains";

export interface PublicConfig {
  chainId: number;
  chainName: string;
  rpcUrl: string;
  explorer?: string;
  contracts: { AgentVault: Address; StallRegistry: Address; IdentityRegistry: Address; ReputationRegistry: Address; tUSD8: Address };
  minStake: string;
  /** Facilitator URL agents use (for the MCP setup snippet). */
  facilitatorUrl: string;
  /** Local chains only (see DEV_WALLET_KEY). */
  devWalletKey?: Hex;
}

declare global {
  interface Window {
    ethereum?: EIP1193Provider & { on?: (e: string, f: (...a: unknown[]) => void) => void; removeListener?: (e: string, f: (...a: unknown[]) => void) => void };
  }
}

/** Readable error: the contract's custom error name when it reverted, else viem's short message. */
export function errorText(err: unknown): string {
  if (err instanceof BaseError) {
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError && reverted.data?.errorName) return `${reverted.data.errorName}${reverted.data.args?.length ? ` (${reverted.data.args.join(", ")})` : ""}`;
    return err.shortMessage;
  }
  return err instanceof Error ? err.message : String(err);
}

function useWalletState(config: PublicConfig) {
  const chain = useMemo(() => ({ ...chainById(config.chainId), rpcUrls: { default: { http: [config.rpcUrl] } } }), [config.chainId, config.rpcUrl]);
  const [account, setAccount] = useState<Address>();
  const [wrongChain, setWrongChain] = useState(false);
  const [hasInjected, setHasInjected] = useState(false);
  const dev = useMemo(() => (config.devWalletKey ? privateKeyToAccount(config.devWalletKey) : undefined), [config.devWalletKey]);

  useEffect(() => setHasInjected(!!window.ethereum), []);
  useEffect(() => {
    if (dev) setAccount(dev.address);
  }, [dev]);

  const clients = useMemo(() => {
    if (dev) return { wallet: createWalletClient({ account: dev, chain, transport: http(config.rpcUrl) }), pub: createPublicClient({ chain, transport: http(config.rpcUrl) }) };
    if (typeof window === "undefined" || !window.ethereum) return undefined;
    const transport = custom(window.ethereum);
    return { wallet: createWalletClient({ chain, transport }), pub: createPublicClient({ chain, transport }) };
  }, [dev, chain, config.rpcUrl, hasInjected]); // eslint-disable-line react-hooks/exhaustive-deps

  const checkChain = useCallback(async () => {
    if (dev || !window.ethereum) return setWrongChain(false);
    const id = (await window.ethereum.request({ method: "eth_chainId" })) as string;
    setWrongChain(Number(id) !== config.chainId);
  }, [dev, config.chainId]);

  const addChain = useCallback(async () => {
    if (!window.ethereum) throw new Error("No browser wallet found. Install MetaMask or another EVM wallet.");
    const hexId = toHex(config.chainId);
    try {
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexId }] });
    } catch {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [{ chainId: hexId, chainName: config.chainName, nativeCurrency: chain.nativeCurrency, rpcUrls: [config.rpcUrl], blockExplorerUrls: config.explorer ? [config.explorer] : undefined }],
      });
    }
    await checkChain();
  }, [chain.nativeCurrency, config, checkChain]);

  const connect = useCallback(async () => {
    if (dev) return setAccount(dev.address);
    if (!window.ethereum) throw new Error("No browser wallet found. Install MetaMask or another EVM wallet.");
    const [a] = (await window.ethereum.request({ method: "eth_requestAccounts" })) as Address[];
    setAccount(a);
    await checkChain();
  }, [dev, checkChain]);

  useEffect(() => {
    if (dev || !window.ethereum?.on) return;
    const onAccounts = (a: unknown) => setAccount((a as Address[])[0]);
    const onChain = () => void checkChain();
    window.ethereum.on("accountsChanged", onAccounts);
    window.ethereum.on("chainChanged", onChain);
    void (window.ethereum.request({ method: "eth_accounts" }) as Promise<Address[]>).then((a) => a[0] && setAccount(a[0]));
    void checkChain();
    return () => {
      window.ethereum?.removeListener?.("accountsChanged", onAccounts);
      window.ethereum?.removeListener?.("chainChanged", onChain);
    };
  }, [dev, checkChain]);

  /** Simulates (so reverts show the contract error), sends a legacy tx (Aevum has no EIP-1559) and waits. */
  const write = useCallback(
    async (address: Address, abi: Abi, functionName: string, args: unknown[]): Promise<TransactionReceipt> => {
      if (!clients || !account) throw new Error("Connect a wallet first");
      if (wrongChain) throw new Error(`Switch your wallet to ${config.chainName}`);
      const { request } = await clients.pub.simulateContract({ account, address, abi, functionName, args } as never);
      const hash = await clients.wallet.writeContract({ ...(request as object), account, chain, type: "legacy" } as never);
      const receipt = await clients.pub.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`${functionName} reverted (${hash})`);
      return receipt;
    },
    [clients, account, wrongChain, chain, config.chainName],
  );

  /** Plain native-token transfer (legacy tx), e.g. gas for an agent key. */
  const sendGas = useCallback(
    async (to: Address, value: bigint) => {
      if (!clients || !account) throw new Error("Connect a wallet first");
      if (wrongChain) throw new Error(`Switch your wallet to ${config.chainName}`);
      const hash = await clients.wallet.sendTransaction({ account, chain, to, value, type: "legacy" } as never);
      const receipt = await clients.pub.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`gas transfer failed (${hash})`);
    },
    [clients, account, wrongChain, chain, config.chainName],
  );

  const signTypedData = useCallback(
    async (data: Parameters<NonNullable<typeof clients>["wallet"]["signTypedData"]>[0]) => {
      if (!clients || !account) throw new Error("Connect a wallet first");
      return clients.wallet.signTypedData({ ...data, account } as never);
    },
    [clients, account],
  );

  return { config, account, connect, addChain, wrongChain, isDev: !!dev, hasWallet: !!dev || hasInjected, write, sendGas, signTypedData };
}

type WalletState = ReturnType<typeof useWalletState>;
const WalletCtx = createContext<WalletState | undefined>(undefined);

export function WalletProvider({ config, children }: { config: PublicConfig; children: ReactNode }) {
  return <WalletCtx.Provider value={useWalletState(config)}>{children}</WalletCtx.Provider>;
}

export function useWallet() {
  const w = useContext(WalletCtx);
  if (!w) throw new Error("useWallet outside WalletProvider");
  return w;
}
