"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { ROBINHOOD_CHAIN_ID } from "../lib/orbio/contracts";
import { shortAddress } from "../lib/ora/format";
import { useWallet } from "../lib/wallet/wallet";

const NAV = [
  { href: "/", label: "Ora" },
  { href: "/app/market", label: "Market" },
  { href: "/app/history", label: "History" },
  { href: "/app/performance", label: "Performance" },
] as const;

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return false;
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AppNav() {
  const pathname = usePathname();
  const [navReady, setNavReady] = useState(false);
  const {
    address,
    chainId,
    connecting,
    connect,
    disconnect,
    switchAccount,
    switchToRobinhood,
  } = useWallet();
  const [error, setError] = useState<string | null>(null);
  const connected = Boolean(address);
  const wrongNetwork = connected && chainId !== ROBINHOOD_CHAIN_ID;

  useEffect(() => {
    setNavReady(true);
  }, []);

  const currentPath = pathname ?? "";

  return (
    <header className="app-nav">
      <nav className="app-links" aria-label="App">
        {NAV.map((link) => {
          const active = navReady && isActive(currentPath, link.href);
          return (
            <Link
              key={link.href}
              href={link.href}
              className={active ? "nav-link active" : "nav-link"}
            >
              {link.label}
            </Link>
          );
        })}
      </nav>
      <div className="wallet-status">
        {!connected && (
          <button
            className={`btn wallet-btn${connecting ? " is-connecting" : ""}`}
            type="button"
            disabled={connecting}
            onClick={() =>
              void connect().catch((err: Error) => setError(err.message))
            }
          >
            {connecting ? "Connecting…" : "Connect wallet"}
          </button>
        )}
        {connected && address && (
          <div className="wallet-chip is-connected">
            <span className="mono">{shortAddress(address)}</span>
            <span className={wrongNetwork ? "warn" : "ok"}>
              {wrongNetwork ? `Chain ${chainId}` : "Robinhood 4663"}
            </span>
            {wrongNetwork && (
              <button
                className="btn secondary"
                type="button"
                onClick={() => void switchToRobinhood()}
              >
                Switch
              </button>
            )}
            <button
              className="btn secondary"
              type="button"
              onClick={() =>
                void switchAccount().catch((err: Error) => setError(err.message))
              }
            >
              Switch account
            </button>
            <button className="btn secondary" type="button" onClick={disconnect}>
              Disconnect
            </button>
          </div>
        )}
        {error && <p className="error nav-error">{error}</p>}
      </div>
    </header>
  );
}
