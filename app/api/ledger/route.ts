import { NextResponse } from "next/server";
import { readLedgerForWallet, updateOwnedDecision } from "../../../lib/db/store";
import {
  decisionAccessResponse,
  missingWalletResponse,
  walletFromBody,
  walletFromRequestUrl,
} from "../../../lib/ora/wallet-request";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const wallet = walletFromRequestUrl(request);
  if (!wallet) {
    return NextResponse.json({ decisions: [] });
  }
  const decisions = await readLedgerForWallet(wallet);
  return NextResponse.json({ decisions });
}

export async function PATCH(request: Request) {
  const body = (await request.json()) as {
    id?: string;
    patch?: Record<string, unknown>;
    walletAddress?: unknown;
    wallet?: unknown;
  };
  const wallet = walletFromBody(body);
  if (!wallet) return missingWalletResponse();
  if (!body.id || !body.patch) {
    return NextResponse.json({ error: "Missing patch." }, { status: 400 });
  }
  const updated = await updateOwnedDecision(body.id, wallet, body.patch);
  if ("error" in updated) return decisionAccessResponse(updated.error);
  return NextResponse.json({ record: updated.record });
}
