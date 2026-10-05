"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { robinhoodChain } from "../lib/orbio/exchange";
import { walletSearchParam } from "../lib/ora/wallet";
import { useWallet } from "../lib/wallet/wallet";

const POLL_INTERVAL_MS = 3_000;
const POLL_WINDOW_MS = 10 * 60 * 1000;

type Phase =
  | "loading"
  | "unavailable"
  | "disconnected"
  | "signing"
  | "awaiting"
  | "connected"
  | "unlinking";

type Challenge = { challengeId: string; message: string };

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json().catch(() => ({}))) as Record<string, unknown>;
}

export function TelegramAlerts() {
  const { address, ethereumProvider } = useWallet();
  const [phase, setPhase] = useState<Phase>("loading");
  const [deepLink, setDeepLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollUntil = useRef(0);

  const readStatus = useCallback(async (): Promise<{
    connected: boolean;
    available: boolean;
  } | null> => {
    if (!address) return null;
    const response = await fetch(`/api/telegram/link${walletSearchParam(address)}`, {
      cache: "no-store",
    });
    if (!response.ok) return null;
    const json = await readJson(response);
    return { connected: json.connected === true, available: json.available === true };
  }, [address]);

  useEffect(() => {
    setDeepLink(null);
    setError(null);
    pollUntil.current = 0;
    if (!address) return;
    let cancelled = false;
    setPhase("loading");
    void readStatus().then((status) => {
      if (cancelled) return;
      if (status?.connected) setPhase("connected");
      else if (status && !status.available) setPhase("unavailable");
      else setPhase("disconnected");
    });
    return () => {
      cancelled = true;
    };
  }, [address, readStatus]);

  useEffect(() => {
    if (phase !== "awaiting") return;
    const timer = setInterval(() => {
      if (Date.now() > pollUntil.current) {
        clearInterval(timer);
        setDeepLink(null);
        setPhase("disconnected");
        setError("The Telegram link expired. Choose Connect Telegram to try again.");
        return;
      }
      void readStatus().then((status) => {
        if (status?.connected) {
          clearInterval(timer);
          setDeepLink(null);
          setPhase("connected");
        }
      });
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [phase, readStatus]);

  const signChallenge = useCallback(
    async (purpose: "link" | "unlink"): Promise<Challenge & { signature: `0x${string}` }> => {
      if (!address || !ethereumProvider) {
        throw new Error("Connect a wallet that can sign messages.");
      }
      const response = await fetch("/api/telegram/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress: address, purpose }),
      });
      const json = await readJson(response);
      if (!response.ok || typeof json.challengeId !== "string" || typeof json.message !== "string") {
        throw new Error(typeof json.error === "string" ? json.error : "Could not start.");
      }
      const { createWalletClient, custom } = await import("viem");
      const signer = createWalletClient({
        chain: robinhoodChain,
        transport: custom(ethereumProvider),
        account: address,
      });
      const signature = await signer.signMessage({ account: address, message: json.message });
      return { challengeId: json.challengeId, message: json.message, signature };
    },
    [address, ethereumProvider],
  );

  const connect = useCallback(async () => {
    setError(null);
    setPhase("signing");
    try {
      const signed = await signChallenge("link");
      const response = await fetch("/api/telegram/link/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          challengeId: signed.challengeId,
          walletAddress: address,
          signature: signed.signature,
        }),
      });
      const json = await readJson(response);
      if (!response.ok || typeof json.deepLink !== "string") {
        throw new Error(typeof json.error === "string" ? json.error : "Could not verify.");
      }
      pollUntil.current = Date.now() + POLL_WINDOW_MS;
      setDeepLink(json.deepLink);
      setPhase("awaiting");
    } catch (err) {
      setPhase("disconnected");
      setError(err instanceof Error ? err.message : "Could not connect Telegram.");
    }
  }, [address, signChallenge]);

  const disconnect = useCallback(async () => {
    setError(null);
    setPhase("unlinking");
    try {
      const signed = await signChallenge("unlink");
      const response = await fetch("/api/telegram/link/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          challengeId: signed.challengeId,
          walletAddress: address,
          signature: signed.signature,
        }),
      });
      const json = await readJson(response);
      if (!response.ok) {
        throw new Error(typeof json.error === "string" ? json.error : "Could not disconnect.");
      }
      setPhase("disconnected");
    } catch (err) {
      setPhase("connected");
      setError(err instanceof Error ? err.message : "Could not disconnect Telegram.");
    }
  }, [address, signChallenge]);

  if (!address) return null;

  return (
    <div className="settings-group telegram-alerts">
      <p className="telegram-alerts-title">Telegram alerts</p>
      {phase === "connected" || phase === "unlinking" ? (
        <>
          <p className="status success-copy">Connected</p>
          <div className="command-actions target-actions">
            <button
              className="btn secondary"
              type="button"
              disabled={phase === "unlinking"}
              onClick={() => void disconnect()}
            >
              {phase === "unlinking" ? "Waiting for signature…" : "Disconnect"}
            </button>
          </div>
        </>
      ) : phase === "unavailable" ? (
        <p className="status">Telegram alerts are not available yet.</p>
      ) : (
        <>
          <p className="status">
            Get notified when your procurement target is ready. Alerts never buy anything.
          </p>
          {phase === "awaiting" && deepLink ? (
            <>
              <p className="status">
                Open Telegram and press Start to finish. This link works once and expires in
                10 minutes.
              </p>
              <div className="command-actions target-actions">
                <a
                  className="btn secondary"
                  href={deepLink}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open Telegram
                </a>
              </div>
            </>
          ) : (
            <div className="command-actions target-actions">
              <button
                className="btn secondary"
                type="button"
                disabled={phase === "loading" || phase === "signing"}
                onClick={() => void connect()}
              >
                {phase === "signing" ? "Waiting for signature…" : "Connect Telegram"}
              </button>
            </div>
          )}
        </>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
