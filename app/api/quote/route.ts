import { NextResponse } from "next/server";
import { quoteForCredit } from "../../../lib/orbio/exchange";
import { decide } from "../../../lib/ora/decision";
import { canReviewDecision } from "../../../lib/ora/evaluation";
import {
  checkAmountAgainstMarket,
  recordedQuoteAmount,
  type AmountRejection,
} from "../../../lib/ora/quote-amount";
import { quoteMeetsMinDiscount } from "../../../lib/ora/quote-rule";
import {
  readSettings,
  requireOwnedDecision,
  updateOwnedDecision,
} from "../../../lib/db/store";
import { readMarketSnapshot } from "../../../lib/orbio/market";
import {
  decisionAccessResponse,
  missingWalletResponse,
  walletFromBody,
} from "../../../lib/ora/wallet-request";

export const dynamic = "force-dynamic";
export const maxDuration = 20;

function amountResponse(rejection: AmountRejection) {
  return NextResponse.json(
    { error: rejection.error, code: rejection.code },
    { status: rejection.status },
  );
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      decisionId?: string;
      walletAddress?: unknown;
      wallet?: unknown;
    };
    const wallet = walletFromBody(body);
    if (!wallet) return missingWalletResponse();
    if (!body.decisionId) {
      return NextResponse.json({ error: "Missing decision." }, { status: 400 });
    }

    const access = await requireOwnedDecision(body.decisionId, wallet);
    if ("error" in access) return decisionAccessResponse(access.error);
    if (!canReviewDecision(access.record)) {
      return NextResponse.json(
        {
          error: "This decision is already finished and cannot be quoted again.",
          code: "terminal",
        },
        { status: 409 },
      );
    }
    const recorded = recordedQuoteAmount(access.record);
    if (!recorded.ok) return amountResponse(recorded);

    const settings = await readSettings(wallet);
    const market = await readMarketSnapshot();

    const liveDecision = decide(market, settings);
    if (liveDecision.action !== "BUY") {
      await updateOwnedDecision(body.decisionId, wallet, {
        executionStatus: "stale_quote",
        blockedReason: "Market no longer meets Ora BUY conditions.",
      });
      return NextResponse.json(
        {
          error:
            "The CREDIT market changed. Ora no longer recommends BUY. Review the desk before trying again.",
          code: "market_changed",
          decision: liveDecision,
        },
        { status: 409 },
      );
    }

    const checked = checkAmountAgainstMarket(
      recorded.requestedCredit,
      market,
      liveDecision.requestedAmount,
    );
    if (!checked.ok) return amountResponse(checked);
    const requestedCredit = checked.requestedCredit;

    const quote = await quoteForCredit(requestedCredit);

    if (quote.creditOut <= 0) {
      return NextResponse.json(
        { error: "Insufficient liquidity for this size.", code: "liquidity" },
        { status: 409 },
      );
    }

    if (quote.totalUsdg > settings.spendingLimitUsdg) {
      return NextResponse.json(
        {
          error: "Quoted cost exceeds Ora spending limit.",
          code: "limit",
          quote,
          spendingLimitUsdg: settings.spendingLimitUsdg,
        },
        { status: 409 },
      );
    }

    const marketPayload = {
      bestDiscount: market.bestDiscount,
      availableAtBestDiscount: market.availableAtBestDiscount,
      creditPrice: market.creditPrice,
      totalAvailableCredit: market.totalAvailableCredit,
    };

    if (!quoteMeetsMinDiscount(quote.discountPercent, settings.minDiscountPercent)) {
      await updateOwnedDecision(body.decisionId, wallet, {
        executionStatus: "review",
        quotePrice: quote.quotePrice,
        quotedUsdg: quote.totalUsdg,
        quotedAt: quote.quotedAt,
        blockedReason: `Executable quote is ${quote.discountPercent}%, below the ${settings.minDiscountPercent}% minimum. Book discount is not the fill price.`,
      });
      return NextResponse.json(
        {
          error: `The executable quote is ${quote.discountPercent}% per CREDIT, below your ${settings.minDiscountPercent}% minimum. The CREDIT book (${market.bestDiscount}%) is not the fill price. Purchase is not offered.`,
          code: "quote_below_threshold",
          quote,
          spendingLimitUsdg: settings.spendingLimitUsdg,
          minDiscountPercent: settings.minDiscountPercent,
          market: marketPayload,
        },
        { status: 409 },
      );
    }

    await updateOwnedDecision(body.decisionId, wallet, {
      executionStatus: "review",
      quotePrice: quote.quotePrice,
      quotedUsdg: quote.totalUsdg,
      quotedAt: quote.quotedAt,
      blockedReason: undefined,
    });

    return NextResponse.json({
      quote,
      spendingLimitUsdg: settings.spendingLimitUsdg,
      minDiscountPercent: settings.minDiscountPercent,
      market: marketPayload,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Quote failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
