"use client";

import { EthersAdapter } from "@reown/appkit-adapter-ethers";
import { defineChain } from "@reown/appkit/networks";
import { createAppKit, type CaipNetworkId } from "@reown/appkit/react";
import { ROBINHOOD_CHAIN_ID, robinhoodRpcUrl } from "../orbio/contracts";

const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL?.trim() || "https://www.useora.site";

const ROBINHOOD_CAIP = `eip155:${ROBINHOOD_CHAIN_ID}` as CaipNetworkId;

export function reownProjectId(): string | undefined {
  const id = process.env.NEXT_PUBLIC_PROJECT_ID?.trim();
  return id || undefined;
}

type RobinhoodWalletNetwork = ReturnType<typeof defineChain>;

let network: RobinhoodWalletNetwork | null = null;
let started = false;

export function robinhoodWalletNetwork(): RobinhoodWalletNetwork | null {
  return network;
}

/**
 * WalletConnect modal for browsers without an injected provider.
 * Injected desktop wallets stay on Ora's existing connection path.
 */
export function ensureAppKit(): boolean {
  if (started) return true;
  if (typeof window === "undefined") return false;
  const projectId = reownProjectId();
  if (!projectId) return false;

  const rpc = robinhoodRpcUrl();
  network = defineChain({
    id: ROBINHOOD_CHAIN_ID,
    caipNetworkId: ROBINHOOD_CAIP,
    chainNamespace: "eip155",
    name: "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
    blockExplorers: {
      default: {
        name: "Blockscout",
        url: "https://robinhoodchain.blockscout.com",
      },
    },
  });

  createAppKit({
    adapters: [new EthersAdapter()],
    projectId,
    networks: [network],
    defaultNetwork: network,
    metadata: {
      name: "Ora",
      description: "Smarter procurement for Orbio CREDIT",
      url: APP_URL,
      icons: [`${APP_URL}/favicon.ico`],
    },
    customRpcUrls: {
      [ROBINHOOD_CAIP]: [{ url: rpc }],
    },
    defaultAccountTypes: { eip155: "eoa" },
    allowUnsupportedChain: true,
    enableWallets: true,
    enableInjected: false,
    enableEIP6963: false,
    enableCoinbase: false,
    enableBaseAccount: false,
    enableReconnect: true,
    experimental_preferUniversalLinks: true,
    features: {
      analytics: false,
      email: false,
      socials: false,
      swaps: false,
      onramp: false,
      history: false,
      send: false,
      receive: false,
      pay: false,
      smartSessions: false,
      reownAuthentication: false,
    },
  });
  started = true;
  return true;
}
