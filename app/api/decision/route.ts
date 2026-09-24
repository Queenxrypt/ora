import { NextResponse } from "next/server";
import { quoteForCredit } from "../../../lib/orbio/exchange";
import { decide, decideWithExecutableQuote } from "../../../lib/ora/decision";
import {
  finalDecisionAction,
  resolveAdvisoryReasoning,
} from "../../../lib/ora/reasoning";
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
    const book = decide(market, settings);
    let evaluated = book;
    if (book.action === "BUY" && book.requestedAmount != null) {
      let quoted;
      try {
        quoted = await quoteForCredit(book.requestedAmount);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "quote failed";
        console.error("Executable quote unavailable:", message);
        return NextResponse.json(
          {
            error:
              "Executable quote unavailable. Ora will not offer a purchase until the quote can be checked.",
          },
          { status: 502 },
        );
      }
      evaluated = decideWithExecutableQuote(market, settings, {
        totalUsdg: quoted.totalUsdg,
        discountPercent: quoted.discountPercent,
        creditOut: quoted.creditOut,
        requestedCredit: quoted.requestedCredit,
      });
    }
    const reasoning = await resolveAdvisoryReasoning(
      evaluated,
      reasonAboutDecision,
    );
    const decision = {
      ...evaluated,
      action: finalDecisionAction(evaluated, reasoning),
    };
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
