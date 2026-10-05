import { NextResponse } from "next/server";
import { markLinkRequestVerified } from "../../../../../lib/db/telegram";
import { telegramBotUsername, telegramLinkingAvailable } from "../../../../../lib/telegram/config";
import {
  checkSignedChallenge,
  INVALID_CHALLENGE_MESSAGE,
} from "../../../../../lib/telegram/challenge";
import {
  createLinkToken,
  hashLinkToken,
  LINK_TOKEN_TTL_MS,
  telegramDeepLink,
} from "../../../../../lib/telegram/link";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

function invalidChallenge() {
  return NextResponse.json({ error: INVALID_CHALLENGE_MESSAGE }, { status: 400 });
}

/**
 * Verifies the wallet's signature and returns a one-time Telegram deep link.
 * No link exists until Telegram delivers that token to the authenticated webhook.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    challengeId?: unknown;
    walletAddress?: unknown;
    wallet?: unknown;
    signature?: unknown;
  };
  const botUsername = telegramBotUsername();
  if (!botUsername || !telegramLinkingAvailable()) {
    return NextResponse.json(
      { error: "Telegram alerts are not available right now." },
      { status: 503 },
    );
  }
  try {
    const now = new Date();
    const challenge = await checkSignedChallenge({
      challengeId: body.challengeId,
      wallet: body.walletAddress ?? body.wallet,
      signature: body.signature,
      purpose: "link",
      now,
    });
    if (!challenge) return invalidChallenge();

    const token = createLinkToken();
    const tokenExpiresAt = new Date(now.getTime() + LINK_TOKEN_TTL_MS).toISOString();
    const verified = await markLinkRequestVerified({
      id: challenge.id,
      walletAddress: challenge.wallet_address,
      purpose: "link",
      now,
      tokenHash: hashLinkToken(token),
      tokenExpiresAt,
    });
    if (!verified) return invalidChallenge();

    return NextResponse.json({
      deepLink: telegramDeepLink(botUsername, token),
      expiresAt: tokenExpiresAt,
    });
  } catch {
    return NextResponse.json({ error: "Could not verify the signature." }, { status: 502 });
  }
}
