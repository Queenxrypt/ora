import { NextResponse } from "next/server";
import { insertLinkRequest, readActiveLinkForWallet } from "../../../../lib/db/telegram";
import {
  missingWalletResponse,
  walletFromBody,
  walletFromRequestUrl,
} from "../../../../lib/ora/wallet-request";
import { oraAppUrl, telegramLinkingAvailable } from "../../../../lib/telegram/config";
import {
  buildLinkMessage,
  createLinkNonce,
  LINK_CHALLENGE_TTL_MS,
  type LinkPurpose,
} from "../../../../lib/telegram/link";

export const dynamic = "force-dynamic";

/** Only whether this wallet currently has an active Telegram link. */
export async function GET(request: Request) {
  const available = telegramLinkingAvailable();
  const wallet = walletFromRequestUrl(request);
  if (!wallet) return NextResponse.json({ connected: false, available });
  try {
    const link = await readActiveLinkForWallet(wallet);
    return NextResponse.json({ connected: link != null, available });
  } catch {
    return NextResponse.json({ error: "Could not read Telegram status." }, { status: 502 });
  }
}

/** Issues a wallet signature challenge for linking (or unlinking) Telegram. */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    walletAddress?: unknown;
    wallet?: unknown;
    purpose?: unknown;
  };
  const wallet = walletFromBody(body);
  if (!wallet) return missingWalletResponse();
  const purpose: LinkPurpose = body.purpose === "unlink" ? "unlink" : "link";
  if (purpose === "link" && !telegramLinkingAvailable()) {
    return NextResponse.json(
      { error: "Telegram alerts are not available right now." },
      { status: 503 },
    );
  }

  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + LINK_CHALLENGE_TTL_MS);
  const nonce = createLinkNonce();
  const message = buildLinkMessage({
    purpose,
    walletAddress: wallet,
    appUrl: oraAppUrl(),
    nonce,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  });
  try {
    const challenge = await insertLinkRequest({
      walletAddress: wallet,
      purpose,
      nonce,
      walletMessage: message,
      expiresAt: expiresAt.toISOString(),
    });
    return NextResponse.json(
      { challengeId: challenge.id, message, expiresAt: challenge.expires_at },
      { status: 201 },
    );
  } catch {
    return NextResponse.json({ error: "Could not start Telegram linking." }, { status: 502 });
  }
}
