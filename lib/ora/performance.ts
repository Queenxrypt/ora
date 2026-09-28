import type { DecisionRecord } from "../../types/ora";
import { discountFromPrice, effectivePrice } from "./baseline";
import { isConfirmedBuy } from "./outcomes";
import {
  afterMarketView,
  formatElapsedDuration,
  type MarketOutcome,
} from "./outcome-engine";

export const COMPARISON_UNAVAILABLE =
  "Not enough executable data yet. Later listed books are observed market conditions, not historical executable quotes.";

export type PerformanceHistoryRow = {
  timestamp: string;
  action: "BUY" | "WAIT";
  observedDiscountPercent: number;
  status: string;
  laterDiscountPercent: number | null;
  appearedAfter: string | null;
};

export type PerformanceReport = {
  hasDecisions: boolean;
  hasEvidence: boolean;
  procurement: {
    confirmedPurchases: number;
    creditPurchased: number;
    usdgSpent: number;
    averageExecutionPrice: number | null;
    averageExecutionDiscount: number | null;
  } | null;
  decisions: {
    buyCount: number;
    waitCount: number;
    total: number;
    completedOutcomes: number;
    pendingOutcomes: number;
  };
  outcomes: {
    waitQualifying: number;
    waitNone: number;
    buyBetter: number;
    buyNone: number;
    pending: number;
  };
  comparison: {
    supported: false;
    detail: string;
  };
  history: PerformanceHistoryRow[];
};

function isEvaluable(outcome: MarketOutcome): boolean {
  if (!outcome.applicable) return false;
  if (outcome.action === "WAIT") {
    return outcome.minDiscountPercent != null && outcome.requestedCredit != null;
  }
  return true;
}

function fillPrice(record: DecisionRecord): number | null {
  if (record.executionPrice != null && Number.isFinite(record.executionPrice)) {
    return record.executionPrice;
  }
  if (
    typeof record.totalUsdgPaid === "number" &&
    typeof record.creditAcquired === "number" &&
    record.creditAcquired > 0
  ) {
    return effectivePrice(record.totalUsdgPaid, record.creditAcquired);
  }
  return null;
}

function historyRow(outcome: MarketOutcome): PerformanceHistoryRow {
  const view = afterMarketView(outcome);
  let laterDiscountPercent: number | null = null;
  let appearedAfter: string | null = null;
  if (outcome.action === "WAIT" && outcome.firstQualifyingOpportunity) {
    laterDiscountPercent = outcome.firstQualifyingOpportunity.observedDiscountPercent;
    appearedAfter = formatElapsedDuration(outcome.firstQualifyingOpportunity.elapsedMs);
  }
  if (outcome.action === "BUY" && outcome.betterObservedOpportunity) {
    laterDiscountPercent = outcome.betterObservedOpportunity.observedDiscountPercent;
    appearedAfter = formatElapsedDuration(outcome.betterObservedOpportunity.elapsedMs);
  }
  return {
    timestamp: outcome.decisionTimestamp,
    action: outcome.action,
    observedDiscountPercent: outcome.originalObservedDiscountPercent,
    status: view?.headline ?? "Observed afterward",
    laterDiscountPercent:
      outcome.lifecycle === "final" ? laterDiscountPercent : null,
    appearedAfter: outcome.lifecycle === "final" ? appearedAfter : null,
  };
}

export function summarizePerformance(
  decisions: DecisionRecord[],
  marketOutcomes: MarketOutcome[],
): PerformanceReport {
  const confirmed = decisions.filter(isConfirmedBuy);
  let creditPurchased = 0;
  let usdgSpent = 0;
  const discounts: number[] = [];
  for (const record of confirmed) {
    creditPurchased += record.creditAcquired as number;
    usdgSpent += record.totalUsdgPaid as number;
    const price = fillPrice(record);
    if (price != null) discounts.push(discountFromPrice(price));
  }

  const buyCount = decisions.filter((item) => item.decision === "BUY").length;
  const waitCount = decisions.filter((item) => item.decision === "WAIT").length;

  let completedOutcomes = 0;
  let pendingOutcomes = 0;
  let waitQualifying = 0;
  let waitNone = 0;
  let buyBetter = 0;
  let buyNone = 0;
  const history: PerformanceHistoryRow[] = [];

  for (const outcome of marketOutcomes) {
    if (!isEvaluable(outcome)) continue;
    if (outcome.lifecycle === "pending") {
      pendingOutcomes += 1;
      history.push(historyRow(outcome));
      continue;
    }
    completedOutcomes += 1;
    if (outcome.action === "WAIT") {
      if (outcome.firstQualifyingOpportunity) waitQualifying += 1;
      else waitNone += 1;
    } else if (outcome.betterObservedOpportunity) {
      buyBetter += 1;
    } else {
      buyNone += 1;
    }
    history.push(historyRow(outcome));
  }

  history.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));

  const hasDecisions = decisions.length > 0;
  const hasEvidence = confirmed.length > 0 || completedOutcomes > 0;

  return {
    hasDecisions,
    hasEvidence,
    procurement:
      confirmed.length === 0
        ? null
        : {
            confirmedPurchases: confirmed.length,
            creditPurchased,
            usdgSpent,
            averageExecutionPrice:
              creditPurchased > 0
                ? Number((usdgSpent / creditPurchased).toFixed(6))
                : null,
            averageExecutionDiscount:
              discounts.length > 0
                ? Number(
                    (
                      discounts.reduce((sum, value) => sum + value, 0) /
                      discounts.length
                    ).toFixed(4),
                  )
                : null,
          },
    decisions: {
      buyCount,
      waitCount,
      total: decisions.length,
      completedOutcomes,
      pendingOutcomes,
    },
    outcomes: {
      waitQualifying,
      waitNone,
      buyBetter,
      buyNone,
      pending: pendingOutcomes,
    },
    comparison: {
      supported: false,
      detail: COMPARISON_UNAVAILABLE,
    },
    history: history.slice(0, 12),
  };
}
