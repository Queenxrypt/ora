"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  createPublicClient,
  createWalletClient,
  custom,
  formatUnits,
  http,
  type Address,
  type WalletClient,
} from "viem";
import {
  CONTRACTS,
  ROBINHOOD_CHAIN_ID,
  robinhoodRpcUrl,
} from "../orbio/contracts";
import { erc20Abi, robinhoodChain } from "../orbio/exchange";

type WalletState = {
  address?: Address;
  chainId?: number;
  connecting: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
  switchToRobinhood: () => Promise<void>;
  walletClient: WalletClient | null;
  usdgBalance: number | null;
  nativeBalance: number | null;
  refreshBalance: () => Promise<void>;
};

const WalletContext = createContext<WalletState | null>(null);

let publicClient: ReturnType<typeof createPublicClient> | null = null;

function getPublicClient() {
  if (!publicClient) {
    publicClient = createPublicClient({
      chain: robinhoodChain,
      transport: http(robinhoodRpcUrl()),
    });
  }
  return publicClient;
}

type WalletSession = {
  address?: Address;
  chainId?: number;
};

/** Survives WalletProvider remounts in the same JS context. Not a reconnect prompt. */
let walletSession: WalletSession = {};

function writeSession(next: WalletSession) {
  walletSession = next;
}

function clientFromInjected(): WalletClient | null {
  const injected = window.ethereum;
  if (!injected) return null;
  return createWalletClient({
    chain: robinhoodChain,
    transport: custom(injected),
  });
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<Address | undefined>(
    walletSession.address,
  );
  const [chainId, setChainId] = useState<number | undefined>(
    walletSession.chainId,
  );
  const [connecting, setConnecting] = useState(false);
  const [walletClient, setWalletClient] = useState<WalletClient | null>(null);
  const [usdgBalance, setUsdgBalance] = useState<number | null>(null);
  const [nativeBalance, setNativeBalance] = useState<number | null>(null);

  const applySession = useCallback(
    (nextAddress: Address | undefined, nextChainId: number | undefined) => {
      setAddress(nextAddress);
      setChainId(nextChainId);
      writeSession({
        address: nextAddress,
        chainId: nextChainId,
      });
    },
    [],
  );

  const refreshBalance = useCallback(async (account?: Address) => {
    const owner = account ?? address;
    if (!owner) {
      setUsdgBalance(null);
      setNativeBalance(null);
      return;
    }
    const [rawUsdg, rawEth] = await Promise.all([
      getPublicClient().readContract({
        address: CONTRACTS.usdg,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [owner],
      }),
      getPublicClient().getBalance({ address: owner }),
    ]);
    setUsdgBalance(Number(formatUnits(rawUsdg as bigint, 6)));
    setNativeBalance(Number(formatUnits(rawEth, 18)));
  }, [address]);

  const connect = useCallback(async () => {
    const provider = window.ethereum;
    if (!provider) {
      throw new Error("No injected wallet found.");
    }
    setConnecting(true);
    try {
      const client = createWalletClient({
        chain: robinhoodChain,
        transport: custom(provider),
      });
      const [account] = await client.requestAddresses();
      const id = await client.getChainId();
      setWalletClient(client);
      applySession(account, id);
      await refreshBalance(account);
    } finally {
      setConnecting(false);
    }
  }, [applySession, refreshBalance]);

  const disconnect = useCallback(() => {
    applySession(undefined, undefined);
    setWalletClient(null);
    setUsdgBalance(null);
    setNativeBalance(null);
  }, [applySession]);

  const switchToRobinhood = useCallback(async () => {
    const provider = window.ethereum;
    if (!provider) return;
    try {
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: "0x1237" }],
      });
    } catch {
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: "0x1237",
            chainName: "Robinhood Chain",
            nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
            rpcUrls: [robinhoodRpcUrl()],
            blockExplorerUrls: ["https://robinhoodchain.blockscout.com"],
          },
        ],
      });
    }
    const id = await (walletClient
      ? walletClient.getChainId()
      : Promise.resolve(ROBINHOOD_CHAIN_ID));
    applySession(address, id);
  }, [address, applySession, walletClient]);

  useEffect(() => {
    if (!walletSession.address || walletClient) return;
    const client = clientFromInjected();
    if (client) setWalletClient(client);
    void refreshBalance(walletSession.address);
  }, [walletClient, refreshBalance]);

  useEffect(() => {
    const provider = window.ethereum;
    if (!provider?.on || !provider.removeListener) return;

    const onChainChanged = (id: unknown) => {
      if (typeof id === "string") {
        const nextId = Number.parseInt(id, 16);
        applySession(walletSession.address, nextId);
      }
      void refreshBalance();
    };
    const keepAccount = (account: Address) => {
      const injected = clientFromInjected();
      if (injected) setWalletClient(injected);
      applySession(account, walletSession.chainId);
      void refreshBalance(account);
    };
    const onAccountsChanged = (accounts: unknown) => {
      const next = Array.isArray(accounts) ? accounts[0] : undefined;
      if (typeof next === "string") {
        keepAccount(next as Address);
        return;
      }
      void (async () => {
        try {
          const current = await provider.request({ method: "eth_accounts" });
          const confirmed = Array.isArray(current) ? current[0] : undefined;
          if (typeof confirmed === "string" && confirmed.trim()) {
            keepAccount(confirmed as Address);
            return;
          }
          if (Array.isArray(current) && current.length === 0) disconnect();
        } catch {
          // eth_accounts did not confirm that the wallet is disconnected.
        }
      })();
    };

    provider.on("chainChanged", onChainChanged);
    provider.on("accountsChanged", onAccountsChanged);
    return () => {
      provider.removeListener?.("chainChanged", onChainChanged);
      provider.removeListener?.("accountsChanged", onAccountsChanged);
    };
  }, [applySession, disconnect, refreshBalance]);

  const value = useMemo(
    () => ({
      address,
      chainId,
      connecting,
      connect,
      disconnect,
      switchToRobinhood,
      walletClient,
      usdgBalance,
      nativeBalance,
      refreshBalance: () => refreshBalance(),
    }),
    [
      address,
      chainId,
      connecting,
      connect,
      disconnect,
      switchToRobinhood,
      walletClient,
      usdgBalance,
      nativeBalance,
      refreshBalance,
    ],
  );

  return (
    <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
  );
}

export function useWallet() {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used within WalletProvider");
  return ctx;
}

declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
      on?: (event: string, handler: (...args: unknown[]) => void) => void;
      removeListener?: (
        event: string,
        handler: (...args: unknown[]) => void,
      ) => void;
    };
  }
}
