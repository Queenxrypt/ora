import { NextResponse } from "next/server";
import { readSucceededObservations } from "../../../lib/db/observations";
import { observationHistoryItems } from "../../../lib/ora/observation-history";

export const dynamic = "force-dynamic";
export const maxDuration = 20;

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET() {
  try {
    const rows = await readSucceededObservations(24);
    const observations = observationHistoryItems(rows);
    return NextResponse.json(
      { observations },
      { headers: NO_STORE },
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Market history unavailable";
    return NextResponse.json(
      { error: message },
      { status: 502, headers: NO_STORE },
    );
  }
}
