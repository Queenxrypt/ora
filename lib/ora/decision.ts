import type {
  DepthLevel,
  ExecutableTerms,
  MarketSnapshot,
  OraDecision,
  ProcurementParams,
} from "../../types/ora";
import { quoteMeetsMinDiscount } from "./quote-rule";

export const DEFAULT_PARAMS: ProcurementParams = {
  minDiscountPercent: 20,
  requestedCredit: 5,
  spendingLimitUsdg: 25,
};

export function decide(
  market: MarketSnapshot,
  params: ProcurementParams,
): OraDecision {
  const timestamp = new Date().toISOString();
  const requested = Math.max(params.requestedCredit, market.minBuyCredit);

  const qualifying = market.depth.filter(
    (level) => level.discountPercent >= params.minDiscountPercent,
  );
  const fillable = qualifying.filter(
    (level) => level.availableCredit >= requested,
  );

  if (fillable.length === 0) {
    return {
      action: "WAIT",
      timestamp,
      market,
      reason: waitReason(market, params, requested, qualifying),
      params,
    };
  }

  const chosen = fillable[0];
  return {
    action: "BUY",
    timestamp,
    market,
    requestedAmount: requested,
    params,
    reason: `${chosen.discountPercent}% discount meets your ${params.minDiscountPercent}% threshold and enough CREDIT is available to fulfill your ${formatCredit(requested)} CREDIT request.`,
  };
}

/**
 * Book screening stays in `decide`. A BUY is executable only after the exchange
 * quote for that same requested amount clears the spending limit and minimum
 * discount. `terms === null` means the quote could not be obtained.
 */
export function decideWithExecutableQuote(
  market: MarketSnapshot,
  params: ProcurementParams,
  terms: ExecutableTerms | null,
): OraDecision {
  const book = decide(market, params);
  if (book.action !== "BUY") return book;

  if (!terms) {
    return quoteWait(
      book,
      "Executable quote is unavailable, so Ora will not offer a purchase.",
    );
  }

  const requested = book.requestedAmount;
  if (terms.requestedCredit !== requested) {
    return quoteWait(
      book,
      `Executable quote is for ${formatCredit(terms.requestedCredit)} CREDIT, not the ${formatCredit(requested ?? 0)} CREDIT request.`,
      terms,
    );
  }

  if (terms.creditOut <= 0) {
    return quoteWait(
      book,
      "Executable quote cannot fill this CREDIT request.",
      terms,
    );
  }

  if (terms.totalUsdg > params.spendingLimitUsdg) {
    return quoteWait(
      book,
      `Executable cost is ${terms.totalUsdg} USDG, above your ${params.spendingLimitUsdg} USDG spending limit.`,
      terms,
    );
  }

  if (!quoteMeetsMinDiscount(terms.discountPercent, params.minDiscountPercent)) {
    return quoteWait(
      book,
      `Executable discount is ${terms.discountPercent}%, below your ${params.minDiscountPercent}% minimum. The book discount is not the fill price.`,
      terms,
    );
  }

  return {
    ...book,
    executable: terms,
    reason: `${book.reason} Executable quote is ${terms.discountPercent}% at ${terms.totalUsdg} USDG.`,
  };
}

function quoteWait(
  book: OraDecision,
  reason: string,
  terms?: ExecutableTerms,
): OraDecision {
  return {
    action: "WAIT",
    timestamp: book.timestamp,
    market: book.market,
    params: book.params,
    reason,
    ...(terms ? { executable: terms } : {}),
  };
}

function waitReason(
  market: MarketSnapshot,
  params: ProcurementParams,
  requested: number,
  qualifying: DepthLevel[],
): string {
  const bestQualifying = qualifying[0];
  if (bestQualifying) {
    return `${bestQualifying.discountPercent}% discount meets your ${params.minDiscountPercent}% threshold, but only ${formatCredit(bestQualifying.availableCredit)} CREDIT is available at that level. You requested ${formatCredit(requested)} CREDIT.`;
  }
  return `Best available discount is ${market.bestDiscount}%, below your ${params.minDiscountPercent}% threshold.`;
}

function formatCredit(value: number): string {
  return value.toLocaleString("en-US", {
    maximumFractionDigits: 2,
  });
}
