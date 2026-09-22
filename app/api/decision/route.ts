import { NextResponse } from "next/server";
import { decide } from "../../../lib/ora/decision";
import { recordFromDecision } from "../../../lib/ora/record";
import { appendDecision, readSettings } from "../../../lib/db/store";
import { readMarketSnapshot } from "../../../lib/orbio/market";
import { reasonAboutDecision } from "../../../lib/orbio/reason";
import {
  missingWalletResponse,
  walletFromBody,
} from "../../../lib/ora/wallet-request";

export const dynamic = "force-dynamic";
export const maxDuration = 20;

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      walletAddress?: unknown;
      wallet?: unknown;
    };
    const wallet = walletFromBody(body);
    if (!wallet) return missingWalletResponse();

    const [market, settings] = await Promise.all([
      readMarketSnapshot(),
      readSettings(wallet),
    ]);
    const decision = decide(market, settings);
    let reasoning = null;
    try {
      reasoning = await reasonAboutDecision(decision);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "unknown error";
      console.error("Orbio reasoning unavailable:", message);
      reasoning = null;
    }
    const record = await appendDecision(
      recordFromDecision(decision, {
        executionStatus: "none",
        walletAddress: wallet,
        ...(reasoning ? { reasoning } : {}),
      }),
    );
    return NextResponse.json({
      decision,
      record,
      reasoning: record.reasoning ?? null,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Decision failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
