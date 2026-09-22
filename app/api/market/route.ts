import { NextResponse } from "next/server";
import { readMarketSnapshot } from "../../../lib/orbio/market";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET() {
  try {
    const market = await readMarketSnapshot();
    return NextResponse.json(
      { market },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Market data unavailable";
    return NextResponse.json(
      { error: message },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
