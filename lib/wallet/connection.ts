export type ConnectionKind = "injected" | "walletconnect";

export type Eip1193Provider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener?: (
    event: string,
    handler: (...args: unknown[]) => void,
  ) => void;
};

export const INJECTED_WALLET_MISSING = "No injected wallet found.";
export const WALLET_UNAVAILABLE = "No wallet is available in this browser.";
export const WALLET_CONNECT_UNCONFIGURED =
  "Mobile wallet connection is not configured.";
export const WALLET_CONNECT_STARTING =
  "Wallet connection is still starting. Try again.";
export const CONNECTION_CANCELLED = "Connection cancelled.";

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function isEvmAddress(value: unknown): value is `0x${string}` {
  return typeof value === "string" && EVM_ADDRESS.test(value);
}

export function asEip1193Provider(value: unknown): Eip1193Provider | null {
  if (!value || typeof value !== "object" || !("request" in value)) return null;
  if (typeof (value as { request?: unknown }).request !== "function") return null;
  return value as Eip1193Provider;
}

/** Desktop injected wallets stay on the existing path. WalletConnect is the fallback. */
export function selectConnectionMethod(input: {
  hasInjectedProvider: boolean;
  hasWalletConnect: boolean;
}): ConnectionKind | "unavailable" {
  if (input.hasInjectedProvider) return "injected";
  if (input.hasWalletConnect) return "walletconnect";
  return "unavailable";
}

export function shouldApplyWalletConnectSession(input: {
  connectionKind: ConnectionKind | null;
  localDisconnect: boolean;
  armed: boolean;
  hasInjectedProvider: boolean;
}): boolean {
  if (input.connectionKind === "injected") return false;
  if (input.localDisconnect && !input.armed) return false;
  if (
    input.hasInjectedProvider &&
    !input.armed &&
    input.connectionKind !== "walletconnect"
  ) {
    return false;
  }
  return true;
}

export function normalizeChainId(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^0x[0-9a-fA-F]+$/.test(trimmed)) {
    const parsed = Number.parseInt(trimmed, 16);
    return Number.isInteger(parsed) ? parsed : undefined;
  }
  const tail = trimmed.includes(":") ? trimmed.slice(trimmed.lastIndexOf(":") + 1) : trimmed;
  if (!/^\d+$/.test(tail)) return undefined;
  const parsed = Number(tail);
  return Number.isInteger(parsed) ? parsed : undefined;
}

export function isUserRejection(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return typeof err === "string" && /user rejected|user denied/i.test(err);
  }
  const code = "code" in err ? (err as { code?: unknown }).code : undefined;
  if (code === 4001 || code === "ACTION_REJECTED") return true;
  const message = err instanceof Error ? err.message : "";
  return /user rejected|user denied|rejected the request|connection request reset|modal closed/i.test(
    message,
  );
}

export function walletErrorMessage(err: unknown, fallback: string): string {
  if (isUserRejection(err)) return CONNECTION_CANCELLED;
  if (err instanceof Error && err.message.trim()) return err.message;
  if (typeof err === "string" && err.trim()) return err;
  return fallback;
}
