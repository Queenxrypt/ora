import type { DecisionRecord, MarketSnapshot } from "../../types/ora";

export type AmountRejection = {
  ok: false;
  status: number;
  code: "market_changed" | "missing_amount" | "size";
  error: string;
};

export type AmountResult = { ok: true; requestedCredit: number } | AmountRejection;

/**
 * The CREDIT amount a decision may be quoted or validated for. It is the
 * amount persisted when Ora decided, already floored to the book minimum.
 * Client-supplied amounts are never used.
 */
export function recordedQuoteAmount(record: DecisionRecord): AmountResult {
  if (record.decision !== "BUY") {
    return {
      ok: false,
      status: 409,
      code: "market_changed",
      error: "Ora does not recommend BUY for this decision. No executable purchase is offered.",
    };
  }
  const amount = record.requestedAmount;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    return missingAmount();
  }
  if (record.executable && record.executable.requestedCredit !== amount) {
    return missingAmount();
  }
  return { ok: true, requestedCredit: amount };
}

/** The recorded amount must still be the amount the live rule would buy. */
export function checkAmountAgainstMarket(
  amount: number,
  market: MarketSnapshot,
  liveRequested: number | undefined,
): AmountResult {
  if (amount < market.minBuyCredit) {
    return {
      ok: false,
      status: 400,
      code: "size",
      error: `Minimum purchase is ${market.minBuyCredit} CREDIT.`,
    };
  }
  if (liveRequested !== amount) {
    return {
      ok: false,
      status: 409,
      code: "market_changed",
      error:
        "The CREDIT amount for this decision no longer matches Ora's current evaluation. Review the desk before trying again.",
    };
  }
  return { ok: true, requestedCredit: amount };
}

function missingAmount(): AmountRejection {
  return {
    ok: false,
    status: 409,
    code: "missing_amount",
    error:
      "This decision has no recorded CREDIT amount to quote. Review the desk for a new decision.",
  };
}
