import { NextResponse } from "next/server";
import { readSucceededObservationsCovering } from "../../../lib/db/observations";
import { readLedgerForWallet } from "../../../lib/db/store";
import {
  DEFAULT_OUTCOME_EVALUATION_WINDOW_MS,
  evaluateMarketOutcome,
  evaluationWindowEnd,
} from "../../../lib/ora/outcome-engine";
import { summarizePerformance } from "../../../lib/ora/performance";
import { walletFromRequestUrl } from "../../../lib/ora/wallet-request";

export const dynamic = "force-dynamic";
export const maxDuration = 20;

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  try {
    const wallet = walletFromRequestUrl(request);
    const decisions = wallet ? await readLedgerForWallet(wallet) : [];
    const observations =
      decisions.length > 0
        ? await readSucceededObservationsCovering(
            coveringStart(decisions),
            coveringEnd(decisions),
          )
        : [];
    const outcomes = decisions.map((decision) =>
      evaluateMarketOutcome(decision, observations),
    );
    const performance = summarizePerformance(decisions, outcomes);
    return NextResponse.json({ performance }, { headers: NO_STORE });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Performance unavailable";
    return NextResponse.json(
      { error: message },
      { status: 502, headers: NO_STORE },
    );
  }
}

function coveringStart(decisions: { timestamp: string }[]): string {
  let earliest = Infinity;
  for (const decision of decisions) {
    const time = Date.parse(decision.timestamp);
    if (Number.isFinite(time) && time < earliest) earliest = time;
  }
  return new Date(earliest).toISOString();
}

function coveringEnd(decisions: { timestamp: string }[]): string {
  let latest = -Infinity;
  for (const decision of decisions) {
    const time = Date.parse(decision.timestamp);
    if (Number.isFinite(time) && time > latest) latest = time;
  }
  return evaluationWindowEnd(
    new Date(latest).toISOString(),
    DEFAULT_OUTCOME_EVALUATION_WINDOW_MS,
  );
}
