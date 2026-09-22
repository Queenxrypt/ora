import { NextResponse } from "next/server";
import { evaluateAll } from "../../../lib/ora/outcomes";
import { summarizePerformance } from "../../../lib/ora/performance";
import { readLedgerForWallet } from "../../../lib/db/store";
import { readMarketSnapshot } from "../../../lib/orbio/market";
import { walletFromRequestUrl } from "../../../lib/ora/wallet-request";

export const dynamic = "force-dynamic";
export const maxDuration = 20;

export async function GET(request: Request) {
  try {
    const wallet = walletFromRequestUrl(request);
    const [decisions, market] = await Promise.all([
      wallet ? readLedgerForWallet(wallet) : Promise.resolve([]),
      readMarketSnapshot().catch(() => null),
    ]);
    const outcomes = evaluateAll(decisions, market);
    const performance = summarizePerformance(decisions, market, outcomes);
    return NextResponse.json({ outcomes, performance, market });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Performance unavailable";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
