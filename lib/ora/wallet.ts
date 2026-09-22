const WALLET_RE = /^0x[a-f0-9]{40}$/;

export function normalizeWalletAddress(
  value: unknown,
): `0x${string}` | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (!WALLET_RE.test(normalized)) return null;
  return normalized as `0x${string}`;
}

export function walletSearchParam(address?: string | null): string {
  const wallet = normalizeWalletAddress(address);
  return wallet ? `?wallet=${encodeURIComponent(wallet)}` : "";
}
