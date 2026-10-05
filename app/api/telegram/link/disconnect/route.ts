import { NextResponse } from "next/server";
import { disableLinkForWallet, markLinkRequestVerified } from "../../../../../lib/db/telegram";
import {
  checkSignedChallenge,
  INVALID_CHALLENGE_MESSAGE,
} from "../../../../../lib/telegram/challenge";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

function invalidChallenge() {
  return NextResponse.json({ error: INVALID_CHALLENGE_MESSAGE }, { status: 400 });
}

/** Disables this wallet's Telegram link after a signed unlink challenge. Alert records are kept. */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    challengeId?: unknown;
    walletAddress?: unknown;
    wallet?: unknown;
    signature?: unknown;
  };
  try {
    const now = new Date();
    const challenge = await checkSignedChallenge({
      challengeId: body.challengeId,
      wallet: body.walletAddress ?? body.wallet,
      signature: body.signature,
      purpose: "unlink",
      now,
    });
    if (!challenge) return invalidChallenge();
    const verified = await markLinkRequestVerified({
      id: challenge.id,
      walletAddress: challenge.wallet_address,
      purpose: "unlink",
      now,
    });
    if (!verified) return invalidChallenge();

    await disableLinkForWallet(challenge.wallet_address, "wallet_requested", now);
    return NextResponse.json({ connected: false });
  } catch {
    return NextResponse.json({ error: "Could not disconnect Telegram." }, { status: 502 });
  }
}
