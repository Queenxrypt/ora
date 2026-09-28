import { NextResponse } from "next/server";
import { readSucceededObservationsBetween } from "../../../lib/db/observations";
import { requireOwnedDecision } from "../../../lib/db/store";
import {
  evaluateMarketOutcome,
  evaluationWindowEnd,
} from "../../../lib/ora/outcome-engine";
import {
  decisionAccessResponse,
  missingWalletResponse,
  walletFromRequestUrl,
} from "../../../lib/ora/wallet-request";

export const dynamic = "force-dynamic";
export const maxDuration = 20;

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  const wallet = walletFromRequestUrl(request);
  if (!wallet) return missingWalletResponse();
  const id = new URL(request.url).searchParams.get("id")?.trim();
  if (!id) {
    return NextResponse.json(
      { error: "id is required." },
      { status: 400, headers: NO_STORE },
    );
  }

  try {
    const access = await requireOwnedDecision(id, wallet);
    if ("error" in access) {
      const response = decisionAccessResponse(access.error);
      response.headers.set("Cache-Control", "no-store");
      return response;
    }
    const { record } = access;
    const windowEnd = evaluationWindowEnd(record.timestamp);
    const observations = await readSucceededObservationsBetween(
      record.timestamp,
      windowEnd,
    );
    const outcome = evaluateMarketOutcome(record, observations);
    return NextResponse.json({ outcome }, { headers: NO_STORE });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Outcome unavailable";
    return NextResponse.json(
      { error: message },
      { status: 502, headers: NO_STORE },
    );
  }
}
