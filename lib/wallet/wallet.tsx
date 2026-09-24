"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  useAppKit,
  useAppKitAccount,
  useAppKitNetwork,
  useAppKitProvider,
  useDisconnect,
} from "@reown/appkit/react";
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
import { ensureAppKit, reownProjectId, robinhoodWalletNetwork } from "./appkit";
import {
  CONNECTION_CANCELLED,
  INJECTED_WALLET_MISSING,
  WALLET_CONNECT_STARTING,
  WALLET_CONNECT_UNCONFIGURED,
  asEip1193Provider,
  isEvmAddress,
  isUserRejection,
  normalizeChainId,
  selectConnectionMethod,
  shouldApplyWalletConnectSession,
  walletErrorMessage,
  type ConnectionKind,
  type Eip1193Provider,
} from "./connection";

type WalletState = {
  address?: Address;
  chainId?: number;
  connecting: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
  switchAccount: () => Promise<void>;
  switchToRobinhood: () => Promise<void>;
  walletClient: WalletClient | null;
  ethereumProvider: Eip1193Provider | null;
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

type WalletConnectSession = {
  address: `0x${string}`;
  chainId?: number;
  provider: Eip1193Provider | null;
};

type WalletConnectControls = {
  openConnect: () => Promise<void>;
  openAccount: () => Promise<void>;
  disconnect: () => Promise<void>;
  switchToRobinhood: () => Promise<void>;
};

/** Survives WalletProvider remounts in the same JS context. Not a reconnect prompt. */
let walletSession: WalletSession = {};
/** Ora-level disconnect. A full reload clears this so eth_accounts can restore. */
let localDisconnect = false;
let connectionKind: ConnectionKind | null = null;
let activeProvider: Eip1193Provider | null = null;
/** User asked for WalletConnect, so the next session may replace a local disconnect. */
let wcArmed = false;
let wcControls: WalletConnectControls | null = null;

function writeSession(next: WalletSession) {
  walletSession = next;
}

function clientFromProvider(provider: Eip1193Provider): WalletClient {
  return createWalletClient({
    chain: robinhoodChain,
    transport: custom(provider),
  });
}

function browserProvider(): Eip1193Provider | null {
  return asEip1193Provider(window.ethereum);
}

function clientFromInjected(): WalletClient | null {
  const injected = browserProvider();
  if (!injected) return null;
  return clientFromProvider(injected);
}

function WalletConnectBridge({
  onSession,
}: {
  onSession: (session: WalletConnectSession | null) => void;
}) {
  const { open } = useAppKit();
  const { disconnect } = useDisconnect();
  const { chainId, switchNetwork } = useAppKitNetwork();
  const { address, isConnected } = useAppKitAccount({ namespace: "eip155" });
  const { walletProvider } = useAppKitProvider<Eip1193Provider>("eip155");
  const provider = asEip1193Provider(walletProvider);
  const hasProvider = Boolean(provider);
  const providerRef = useRef<Eip1193Provider | null>(provider);
  providerRef.current = provider;

  wcControls = {
    openConnect: async () => {
      await open({ view: "Connect", namespace: "eip155" });
    },
    openAccount: async () => {
      await open({ view: "Account" });
    },
    disconnect: async () => {
      await disconnect({ namespace: "eip155" });
    },
    switchToRobinhood: async () => {
      const network = robinhoodWalletNetwork();
      if (!network) {
        throw new Error("Robinhood Chain is not ready in the wallet connection.");
      }
      await switchNetwork(network);
    },
  };

  useEffect(() => {
    if (!isConnected || !isEvmAddress(address)) {
      onSession(null);
      return;
    }
    onSession({
      address,
      chainId: normalizeChainId(chainId),
      provider: providerRef.current,
    });
  }, [address, chainId, hasProvider, isConnected, onSession]);

  useEffect(() => {
    return () => {
      wcControls = null;
    };
  }, []);

  return null;
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
  const [ethereumProvider, setEthereumProvider] =
    useState<Eip1193Provider | null>(activeProvider);
  const [transport, setTransport] = useState<ConnectionKind | null>(
    connectionKind,
  );
  const [usdgBalance, setUsdgBalance] = useState<number | null>(null);
  const [nativeBalance, setNativeBalance] = useState<number | null>(null);
  const [wcReady, setWcReady] = useState(false);
  const [wcInitError, setWcInitError] = useState<string | null>(null);

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

  const onWalletConnectSession = useCallback(
    (session: WalletConnectSession | null) => {
      if (!session) {
        if (connectionKind !== "walletconnect") return;
        connectionKind = null;
        activeProvider = null;
        setTransport(null);
        applySession(undefined, undefined);
        setWalletClient(null);
        setEthereumProvider(null);
        setUsdgBalance(null);
        setNativeBalance(null);
        return;
      }
      if (
        !shouldApplyWalletConnectSession({
          connectionKind,
          localDisconnect,
          armed: wcArmed,
          hasInjectedProvider: Boolean(window.ethereum),
        })
      ) {
        return;
      }
      localDisconnect = false;
      wcArmed = false;
      connectionKind = "walletconnect";
      setTransport("walletconnect");
      const same =
        walletSession.address?.toLowerCase() === session.address.toLowerCase() &&
        walletSession.chainId === session.chainId;
      if (!same) applySession(session.address as Address, session.chainId);
      if (session.provider && session.provider !== activeProvider) {
        activeProvider = session.provider;
        setEthereumProvider(session.provider);
        setWalletClient(clientFromProvider(session.provider));
      }
      if (!same) void refreshBalance(session.address as Address);
    },
    [applySession, refreshBalance],
  );

  useEffect(() => {
    try {
      setWcReady(ensureAppKit());
    } catch (err) {
      setWcInitError(
        err instanceof Error ? err.message : "Wallet connection failed to start.",
      );
    }
  }, []);

  const connect = useCallback(async () => {
    const method = selectConnectionMethod({
      hasInjectedProvider: Boolean(window.ethereum),
      hasWalletConnect: Boolean(reownProjectId()) || wcReady,
    });
    if (method === "unavailable") {
      throw new Error(wcInitError ?? WALLET_CONNECT_UNCONFIGURED);
    }
    if (method === "walletconnect" && (!wcReady || !wcControls)) {
      throw new Error(wcInitError ?? WALLET_CONNECT_STARTING);
    }
    if (method === "injected") {
      const provider = browserProvider();
      if (!provider) throw new Error(INJECTED_WALLET_MISSING);
      setConnecting(true);
      try {
        const client = clientFromProvider(provider);
        const [account] = await client.requestAddresses();
        const id = await client.getChainId();
        connectionKind = "injected";
        activeProvider = provider;
        setTransport("injected");
        setWalletClient(client);
        setEthereumProvider(provider);
        localDisconnect = false;
        applySession(account, id);
        await refreshBalance(account);
      } finally {
        setConnecting(false);
      }
      return;
    }

    if (!wcControls) throw new Error(wcInitError ?? WALLET_CONNECT_STARTING);
    wcArmed = true;
    setConnecting(true);
    try {
      await wcControls.openConnect();
    } catch (err) {
      wcArmed = false;
      if (isUserRejection(err)) throw new Error(CONNECTION_CANCELLED);
      throw new Error(walletErrorMessage(err, "Could not connect the wallet."));
    } finally {
      setConnecting(false);
    }
  }, [applySession, refreshBalance, wcInitError, wcReady]);

  const disconnect = useCallback(() => {
    const kind = connectionKind;
    localDisconnect = true;
    wcArmed = false;
    connectionKind = null;
    activeProvider = null;
    setTransport(null);
    applySession(undefined, undefined);
    setWalletClient(null);
    setEthereumProvider(null);
    setUsdgBalance(null);
    setNativeBalance(null);
    if (kind === "walletconnect") {
      void wcControls?.disconnect().catch(() => {
        // The WalletConnect session may already be gone.
      });
    }
  }, [applySession]);

  const switchAccount = useCallback(async () => {
    if (connectionKind === "walletconnect") {
      if (!wcControls) throw new Error(WALLET_CONNECT_STARTING);
      try {
        await wcControls.openAccount();
      } catch (err) {
        if (isUserRejection(err)) throw new Error(CONNECTION_CANCELLED);
        throw new Error(
          walletErrorMessage(err, "Could not open the connected wallet."),
        );
      }
      return;
    }

    const provider = browserProvider();
    if (!provider) throw new Error(INJECTED_WALLET_MISSING);
    const previous = walletSession.address?.toLowerCase();
    let permissionError: unknown = null;
    try {
      await provider.request({
        method: "wallet_requestPermissions",
        params: [{ eth_accounts: {} }],
      });
    } catch (err) {
      permissionError = err;
    }

    let current: unknown;
    try {
      current = await provider.request({ method: "eth_accounts" });
    } catch (err) {
      if (!permissionError) throw err;
      const message =
        permissionError instanceof Error
          ? permissionError.message
          : "Could not switch account.";
      throw new Error(message);
    }

    const account = Array.isArray(current) ? current[0] : undefined;
    const valid =
      typeof account === "string" && account.trim()
        ? (account as Address)
        : undefined;
    const changed = valid != null && valid.toLowerCase() !== previous;
    if (valid && (!permissionError || changed)) {
      const client = clientFromInjected();
      if (!client) throw new Error(INJECTED_WALLET_MISSING);
      const id = await client.getChainId();
      connectionKind = "injected";
      activeProvider = provider;
      setTransport("injected");
      setWalletClient(client);
      setEthereumProvider(provider);
      applySession(valid, id);
      await refreshBalance(valid);
      return;
    }

    if (permissionError) {
      const message =
        permissionError instanceof Error
          ? permissionError.message
          : "Could not switch account.";
      throw new Error(message);
    }
    throw new Error("No account selected.");
  }, [applySession, refreshBalance]);

  const switchToRobinhood = useCallback(async () => {
    if (connectionKind === "walletconnect") {
      if (!wcControls) throw new Error(WALLET_CONNECT_STARTING);
      try {
        await wcControls.switchToRobinhood();
      } catch (err) {
        if (isUserRejection(err)) throw new Error("Network switch cancelled.");
        throw new Error(
          walletErrorMessage(err, "Could not switch to Robinhood Chain."),
        );
      }
      return;
    }

    const provider = browserProvider();
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
    if (localDisconnect || walletSession.address) return;
    if (connectionKind === "walletconnect") return;
    const provider = browserProvider();
    if (!provider) return;
    let cancelled = false;
    void (async () => {
      try {
        const current = await provider.request({ method: "eth_accounts" });
        const account = Array.isArray(current) ? current[0] : undefined;
        if (cancelled || localDisconnect || walletSession.address) return;
        if (typeof account !== "string" || !account.trim()) return;
        const client = clientFromInjected();
        if (!client || cancelled || localDisconnect) return;
        const id = await client.getChainId();
        if (cancelled || localDisconnect || walletSession.address) return;
        connectionKind = "injected";
        activeProvider = provider;
        setTransport("injected");
        setWalletClient(client);
        setEthereumProvider(provider);
        applySession(account as Address, id);
        await refreshBalance(account as Address);
      } catch {
        // Stay disconnected. eth_accounts must not prompt.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applySession, refreshBalance]);

  useEffect(() => {
    if (!walletSession.address || walletClient) return;
    const provider =
      activeProvider ??
      (connectionKind !== "walletconnect" ? browserProvider() : null);
    if (!provider) return;
    activeProvider = provider;
    setEthereumProvider(provider);
    setWalletClient(clientFromProvider(provider));
    void refreshBalance(walletSession.address);
  }, [walletClient, refreshBalance]);

  useEffect(() => {
    if (transport === "walletconnect") return;
    const provider = browserProvider();
    if (!provider?.on || !provider.removeListener) return;

    const onChainChanged = (id: unknown) => {
      if (connectionKind === "walletconnect") return;
      if (typeof id === "string") {
        const nextId = Number.parseInt(id, 16);
        applySession(walletSession.address, nextId);
      }
      void refreshBalance();
    };
    const keepAccount = (account: Address) => {
      const injected = browserProvider();
      const client = injected ? clientFromProvider(injected) : null;
      if (injected && client) {
        activeProvider = injected;
        setEthereumProvider(injected);
        setWalletClient(client);
      }
      connectionKind = "injected";
      setTransport("injected");
      applySession(account, walletSession.chainId);
      void refreshBalance(account);
    };
    const onAccountsChanged = (accounts: unknown) => {
      if (connectionKind === "walletconnect") return;
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
  }, [applySession, disconnect, refreshBalance, transport]);

  const value = useMemo(
    () => ({
      address,
      chainId,
      connecting,
      connect,
      disconnect,
      switchAccount,
      switchToRobinhood,
      walletClient,
      ethereumProvider,
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
      switchAccount,
      switchToRobinhood,
      walletClient,
      ethereumProvider,
      usdgBalance,
      nativeBalance,
      refreshBalance,
    ],
  );

  return (
    <WalletContext.Provider value={value}>
      {wcReady ? <WalletConnectBridge onSession={onWalletConnectSession} /> : null}
      {children}
    </WalletContext.Provider>
  );
}

export function useWallet() {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used within WalletProvider");
  return ctx;
}
