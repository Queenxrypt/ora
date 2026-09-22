import type {
  DecisionOutcome,
  DecisionRecord,
  ExecutionStatus,
  MarketSnapshot,
  OutcomePhase,
} from "../../types/ora";
import { buyOnDemandCost, discountFromPrice, effectivePrice } from "./baseline";

const ATTEMPTED: ExecutionStatus[] = [
  "quoting",
  "review",
  "validating",
  "awaiting_signature",
  "pending",
  "failed",
  "blocked_limit",
  "blocked_liquidity",
  "blocked_funds",
  "stale_quote",
];

export function isConfirmedBuy(record: DecisionRecord): boolean {
  return (
    record.decision === "BUY" &&
    record.executionStatus === "success" &&
    typeof record.creditAcquired === "number" &&
    record.creditAcquired > 0 &&
    typeof record.totalUsdgPaid === "number"
  );
}

export function isLaterSnapshot(
  record: DecisionRecord,
  later: MarketSnapshot | null,
): later is MarketSnapshot {
  if (!later) return false;
  const origin = Date.parse(record.confirmedAt ?? record.timestamp);
  const next = Date.parse(later.timestamp);
  return Number.isFinite(origin) && Number.isFinite(next) && next > origin;
}

function unresolved(
  record: DecisionRecord,
  phase: OutcomePhase,
  summary: string,
  later: MarketSnapshot | null,
): DecisionOutcome {
  return {
    decisionId: record.id,
    kind: record.decision,
    phase,
    resolved: false,
    useful: null,
    summary,
    decisionTimestamp: record.timestamp,
    decisionDiscountPercent: record.market.discountPercent,
    decisionCreditPrice: record.market.price,
    executionStatus: record.executionStatus,
    executionPrice: record.executionPrice ?? record.quotePrice,
    executionDiscountPercent:
      record.executionPrice != null
        ? discountFromPrice(record.executionPrice)
        : record.quotePrice != null
          ? discountFromPrice(record.quotePrice)
          : undefined,
    creditAcquired: record.creditAcquired,
    usdgPaid: record.totalUsdgPaid,
    laterTimestamp: later?.timestamp,
    laterDiscountPercent: later?.discountPercent,
    laterCreditPrice: later?.creditPrice,
  };
}

export function evaluateDecision(
  record: DecisionRecord,
  later: MarketSnapshot | null,
): DecisionOutcome {
  if (record.decision === "BUY") {
    if (!isConfirmedBuy(record)) {
      const attempted = ATTEMPTED.includes(record.executionStatus ?? "none");
      return unresolved(
        record,
        attempted ? "execution" : "decision",
        attempted
          ? "BUY was not confirmed onchain. Ora does not treat a reviewed, pending, rejected, or failed purchase as an outcome."
          : "BUY was recorded as a decision only. No confirmed execution exists to evaluate.",
        later,
      );
    }

    const acquired = record.creditAcquired as number;
    const oraCost = record.totalUsdgPaid as number;
    const execPrice =
      record.executionPrice ?? effectivePrice(oraCost, acquired);
    const execDiscount = discountFromPrice(execPrice);

    if (!isLaterSnapshot(record, later)) {
      return {
        ...unresolved(
          record,
          "confirmed",
          "Purchase is confirmed. Outcome vs a later buy-on-demand price is unresolved until a later market snapshot exists.",
          later,
        ),
        executionPrice: execPrice,
        executionDiscountPercent: execDiscount,
        creditAcquired: acquired,
        usdgPaid: oraCost,
        oraCost,
      };
    }

    const laterCost = buyOnDemandCost(acquired, later);
    const difference = Number((laterCost - oraCost).toFixed(6));
    const useful = difference > 0;
    return {
      decisionId: record.id,
      kind: "BUY",
      phase: "outcome",
      resolved: true,
      useful,
      summary: useful
        ? `Confirmed fill paid ${oraCost} USDG for ${acquired} CREDIT (effective ${execDiscount}% / ${execPrice} USDG per CREDIT). Buying the same size later at the ${later.discountPercent}% book (${later.creditPrice} USDG/CREDIT) would have cost ${laterCost} USDG.`
        : `Confirmed fill paid ${oraCost} USDG for ${acquired} CREDIT (effective ${execDiscount}% / ${execPrice} USDG per CREDIT). Buying the same size later at the ${later.discountPercent}% book (${later.creditPrice} USDG/CREDIT) would have cost ${laterCost} USDG — lower than or equal to Ora's fill.`,
      decisionTimestamp: record.timestamp,
      decisionDiscountPercent: record.market.discountPercent,
      decisionCreditPrice: record.market.price,
      executionStatus: record.executionStatus,
      executionPrice: execPrice,
      executionDiscountPercent: execDiscount,
      creditAcquired: acquired,
      usdgPaid: oraCost,
      laterTimestamp: later.timestamp,
      laterDiscountPercent: later.discountPercent,
      laterCreditPrice: later.creditPrice,
      buyOnDemandCost: laterCost,
      oraCost,
      costDifference: difference,
    };
  }

  if (!isLaterSnapshot(record, later)) {
    return unresolved(
      record,
      "decision",
      "WAIT is recorded. Outcome vs a later book is unresolved until a later market snapshot exists.",
      later,
    );
  }

  const laterBetter = later.discountPercent > record.market.discountPercent;
  const laterWorse = later.discountPercent < record.market.discountPercent;
  let summary: string;
  if (laterBetter) {
    summary = `After the wait (${record.market.discountPercent}%), a better listed discount appeared (${later.discountPercent}%). That is a later opportunity, not a claim that waiting is a winning strategy.`;
  } else if (laterWorse) {
    summary = `After the wait (${record.market.discountPercent}%), the later book listed a thinner discount (${later.discountPercent}%). The earlier level was not present on this later snapshot.`;
  } else {
    summary = `Later listed discount (${later.discountPercent}%) matches the wait snapshot. This comparison shows no change.`;
  }

  return {
    decisionId: record.id,
    kind: "WAIT",
    phase: "outcome",
    resolved: true,
    useful: laterBetter ? true : laterWorse ? false : null,
    summary,
    decisionTimestamp: record.timestamp,
    decisionDiscountPercent: record.market.discountPercent,
    decisionCreditPrice: record.market.price,
    executionStatus: record.executionStatus,
    laterTimestamp: later.timestamp,
    laterDiscountPercent: later.discountPercent,
    laterCreditPrice: later.creditPrice,
  };
}

export function evaluateAll(
  records: DecisionRecord[],
  latest: MarketSnapshot | null,
): DecisionOutcome[] {
  return records.map((record) => evaluateDecision(record, latest));
}
