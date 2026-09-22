import { NextResponse } from "next/server";
import { quoteForCredit } from "../../../../lib/orbio/exchange";
import { decide } from "../../../../lib/ora/decision";
import { quoteMeetsMinDiscount } from "../../../../lib/ora/quote-rule";
import {
  readSettings,
  requireOwnedDecision,
  updateOwnedDecision,
} from "../../../../lib/db/store";
import { readMarketSnapshot } from "../../../../lib/orbio/market";
import type { ExecutableQuote } from "../../../../types/ora";
import {
  decisionAccessResponse,
  missingWalletResponse,
  walletFromBody,
} from "../../../../lib/ora/wallet-request";

const QUOTE_MAX_AGE_MS = 90_000;

function quotesMatch(a: ExecutableQuote, b: ExecutableQuote) {
  const delta = Math.abs(a.totalUsdg - b.totalUsdg);
  return delta <= 0.05 || delta / Math.max(a.totalUsdg, 0.000001) <= 0.01;
}

export const dynamic = "force-dynamic";
export const maxDuration = 20;

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      decisionId?: string;
      quote?: ExecutableQuote;
      walletAddress?: unknown;
      wallet?: unknown;
    };
    const wallet = walletFromBody(body);
    if (!wallet) return missingWalletResponse();
    if (!body.decisionId || !body.quote) {
      return NextResponse.json({ error: "Missing quote." }, { status: 400 });
    }

    const access = await requireOwnedDecision(body.decisionId, wallet);
    if ("error" in access) return decisionAccessResponse(access.error);
    const current = access.record;
    if (current.decision !== "BUY") {
      return NextResponse.json(
        {
          error: "Ora does not recommend BUY at the current book. No purchase is sent.",
          code: "market_changed",
        },
        { status: 409 },
      );
    }

    const settings = await readSettings(wallet);
    const market = await readMarketSnapshot();

    if (body.quote.requestedCredit < market.minBuyCredit) {
      return NextResponse.json(
        {
          error: `Minimum purchase is ${market.minBuyCredit} CREDIT.`,
          code: "size",
        },
        { status: 400 },
      );
    }

    const quotedAt = Date.parse(body.quote.quotedAt);
    if (
      Number.isFinite(quotedAt) &&
      Date.now() - quotedAt > QUOTE_MAX_AGE_MS
    ) {
      await updateOwnedDecision(body.decisionId, wallet, {
        executionStatus: "stale_quote",
        blockedReason: "Quote expired before confirmation.",
      });
      return NextResponse.json(
        {
          error: "Quote expired. Review a fresh quote before sending.",
          code: "stale",
        },
        { status: 409 },
      );
    }

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

    const fresh = await quoteForCredit(body.quote.requestedCredit);

    if (fresh.creditOut <= 0) {
      await updateOwnedDecision(body.decisionId, wallet, {
        executionStatus: "blocked_liquidity",
        blockedReason: "Insufficient liquidity on revalidation.",
      });
      return NextResponse.json(
        { error: "Insufficient liquidity.", code: "liquidity" },
        { status: 409 },
      );
    }

    if (fresh.totalUsdg > settings.spendingLimitUsdg) {
      await updateOwnedDecision(body.decisionId, wallet, {
        executionStatus: "blocked_limit",
        blockedReason: "Spending limit exceeded on revalidation.",
      });
      return NextResponse.json(
        {
          error: "Quoted cost exceeds Ora spending limit.",
          code: "limit",
          quote: fresh,
        },
        { status: 409 },
      );
    }

    if (!quoteMeetsMinDiscount(fresh.discountPercent, settings.minDiscountPercent)) {
      await updateOwnedDecision(body.decisionId, wallet, {
        executionStatus: "review",
        quotePrice: fresh.quotePrice,
        quotedUsdg: fresh.totalUsdg,
        quotedAt: fresh.quotedAt,
        blockedReason: `Executable quote is ${fresh.discountPercent}%, below the ${settings.minDiscountPercent}% minimum.`,
      });
      return NextResponse.json(
        {
          error: `The executable quote is ${fresh.discountPercent}% per CREDIT, below your ${settings.minDiscountPercent}% minimum. The CREDIT book is not the fill price. Purchase is not offered.`,
          code: "quote_below_threshold",
          quote: fresh,
        },
        { status: 409 },
      );
    }

    if (!quotesMatch(body.quote, fresh)) {
      await updateOwnedDecision(body.decisionId, wallet, {
        executionStatus: "stale_quote",
        blockedReason: "Quote changed before confirmation.",
        quotePrice: fresh.quotePrice,
        quotedUsdg: fresh.totalUsdg,
      });
      return NextResponse.json(
        {
          error: "Quote changed. Review the new price before sending.",
          code: "stale",
          quote: fresh,
        },
        { status: 409 },
      );
    }

    await updateOwnedDecision(body.decisionId, wallet, {
      quotePrice: fresh.quotePrice,
      quotedUsdg: fresh.totalUsdg,
      quotedAt: fresh.quotedAt,
      requestedAmount: body.quote.requestedCredit,
      executionStatus: "awaiting_signature",
    });

    return NextResponse.json({
      quote: fresh,
      spendingLimitUsdg: settings.spendingLimitUsdg,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Validation failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
