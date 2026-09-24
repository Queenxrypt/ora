import { NextResponse } from "next/server";
import { readLedgerForWallet } from "../../../lib/db/store";
import { walletFromRequestUrl } from "../../../lib/ora/wallet-request";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const wallet = walletFromRequestUrl(request);
  if (!wallet) {
    return NextResponse.json({ decisions: [] });
  }
  const decisions = await readLedgerForWallet(wallet);
  return NextResponse.json({ decisions });
}
