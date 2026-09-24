"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
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
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const connected = Boolean(address);
  const wrongNetwork = connected && chainId !== ROBINHOOD_CHAIN_ID;
  const networkLabel = wrongNetwork ? `Chain ${chainId}` : "Robinhood 4663";

  useEffect(() => {
    setNavReady(true);
  }, []);

  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!menuOpen) return;
    function onPointerDown(event: MouseEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  const currentPath = pathname ?? "";

  return (
    <header className="app-nav">
      <div className="app-nav-bar">
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
            <div className="wallet-menu-wrap" ref={menuRef}>
              <button
                className="wallet-account"
                type="button"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((open) => !open)}
              >
                <span className="mono">{shortAddress(address)}</span>
                <span className="wallet-account-caret" aria-hidden="true">
                  ▾
                </span>
              </button>
              {menuOpen && (
                <div className="wallet-menu" role="menu">
                  <p className="wallet-menu-kicker">Connected wallet</p>
                  <p className="mono wallet-menu-address">{shortAddress(address)}</p>
                  <p className={wrongNetwork ? "warn wallet-menu-network" : "ok wallet-menu-network"}>
                    {networkLabel}
                  </p>
                  {wrongNetwork && (
                    <button
                      className="wallet-menu-item"
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false);
                        void switchToRobinhood();
                      }}
                    >
                      Switch network
                    </button>
                  )}
                  <button
                    className="wallet-menu-item"
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      void switchAccount()
                        .then(() => setError(null))
                        .catch((err: Error) => setError(err.message));
                    }}
                  >
                    Switch account
                  </button>
                  <button
                    className="wallet-menu-item"
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      disconnect();
                    }}
                  >
                    Disconnect
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      {error && <p className="error nav-error">{error}</p>}
    </header>
  );
}
