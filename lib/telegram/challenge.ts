import { readLinkRequest, type TelegramLinkRequestRow } from "../db/telegram";
import { normalizeWalletAddress } from "../ora/wallet";
import { verifyWalletSignature, type LinkPurpose } from "./link";

export const INVALID_CHALLENGE_MESSAGE =
  "This signature request is invalid or has expired. Start again from Ora.";

const CHALLENGE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Returns the challenge only when it exists, has the expected purpose, belongs
 * to this wallet, is unexpired and unverified, and the wallet signed exactly
 * the stored message. Callers still mark it verified with a conditional write.
 */
export async function checkSignedChallenge(input: {
  challengeId: unknown;
  wallet: unknown;
  signature: unknown;
  purpose: LinkPurpose;
  now: Date;
}): Promise<TelegramLinkRequestRow | null> {
  if (typeof input.challengeId !== "string" || !CHALLENGE_ID_RE.test(input.challengeId)) {
    return null;
  }
  const wallet = normalizeWalletAddress(input.wallet);
  if (!wallet || typeof input.signature !== "string") return null;

  const request = await readLinkRequest(input.challengeId.toLowerCase());
  if (!request) return null;
  if (request.purpose !== input.purpose) return null;
  if (request.wallet_address !== wallet) return null;
  if (request.verified_at != null) return null;
  if (Date.parse(request.expires_at) <= input.now.getTime()) return null;

  const valid = await verifyWalletSignature({
    address: wallet,
    message: request.wallet_message,
    signature: input.signature,
  });
  return valid ? request : null;
}
