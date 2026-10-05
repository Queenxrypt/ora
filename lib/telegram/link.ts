import { createHash, randomBytes } from "node:crypto";
import { verifyMessage, type Hex } from "viem";
import { publicClient } from "../orbio/exchange";

/** How long the wallet has to sign the challenge. */
export const LINK_CHALLENGE_TTL_MS = 10 * 60 * 1000;
/** How long the Telegram deep-link token stays valid after the signature. */
export const LINK_TOKEN_TTL_MS = 10 * 60 * 1000;

const SIGNATURE_RPC_TIMEOUT_MS = 5_000;

export type LinkPurpose = "link" | "unlink";

/** 128 random bits, hex. */
export function createLinkNonce(): string {
  return randomBytes(16).toString("hex");
}

/**
 * 32 random bytes as base64url: 43 characters from Telegram's allowed /start
 * parameter alphabet. Only its SHA-256 is ever stored.
 */
export function createLinkToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashLinkToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function isLinkTokenFormat(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

export function telegramDeepLink(botUsername: string, token: string): string {
  return `https://t.me/${botUsername}?start=${token}`;
}

export function buildLinkMessage(input: {
  purpose: LinkPurpose;
  walletAddress: string;
  appUrl: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}): string {
  const domain = new URL(input.appUrl).host;
  const action =
    input.purpose === "link"
      ? "Link Telegram alerts to Ora for this wallet."
      : "Disconnect Telegram alerts from Ora for this wallet.";
  return [
    `${domain} asks you to sign this message.`,
    "",
    action,
    "",
    `Wallet: ${input.walletAddress}`,
    `Application: Ora (${input.appUrl})`,
    "",
    "This signature authorizes NO transaction.",
    "It authorizes NO spending.",
    "It authorizes NO CREDIT purchase.",
    "It only proves that you control this wallet.",
    "",
    `Nonce: ${input.nonce}`,
    `Issued At: ${input.issuedAt}`,
    `Expiration Time: ${input.expiresAt}`,
  ].join("\n");
}

function isHexSignature(value: string): value is Hex {
  return /^0x(?:[0-9a-fA-F]{2})+$/.test(value);
}

async function verifyContractSignature(
  address: `0x${string}`,
  message: string,
  signature: Hex,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), SIGNATURE_RPC_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      publicClient().verifyMessage({ address, message, signature }),
      timeout,
    ]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Verifies a personal_sign signature of `message` by `address`. Plain wallets
 * are checked locally; smart-contract wallets fall back to an on-chain
 * ERC-1271/6492 check on Robinhood Chain.
 */
export async function verifyWalletSignature(input: {
  address: `0x${string}`;
  message: string;
  signature: string;
}): Promise<boolean> {
  const signature = input.signature.trim();
  if (!isHexSignature(signature)) return false;
  try {
    if (await verifyMessage({ address: input.address, message: input.message, signature })) {
      return true;
    }
  } catch {
    // Not a recoverable ECDSA signature; a contract wallet may still accept it.
  }
  return verifyContractSignature(input.address, input.message, signature);
}
