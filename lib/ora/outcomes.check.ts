import type { DecisionRecord, MarketSnapshot } from "../../types/ora";
import { evaluateDecision, isConfirmedBuy } from "./outcomes";
import { summarizePerformance } from "./performance";
import { buyOnDemandCost } from "./baseline";

function snapshot(
  partial: Partial<MarketSnapshot> &
    Pick<MarketSnapshot, "timestamp" | "creditPrice" | "discountPercent">,
): MarketSnapshot {
  return {
    bestDiscount: partial.discountPercent,
    availableAtBestDiscount: 50,
    depth: [
      {
        discountPercent: partial.discountPercent,
        availableCredit: 50,
      },
    ],
    source: "orbio",
    totalAvailableCredit: 50,
    minBuyCredit: 5,
    ...partial,
  };
}

function record(partial: Partial<DecisionRecord> & Pick<DecisionRecord, "id" | "decision">): DecisionRecord {
  const price = partial.market?.price ?? 0.8;
  const discount = partial.market?.discountPercent ?? 20;
  return {
    timestamp: "2026-09-20T10:00:00.000Z",
    market: { price, discountPercent: discount, availableDepth: 50 },
    snapshot: snapshot({
      timestamp: "2026-09-20T10:00:00.000Z",
      creditPrice: price,
      discountPercent: discount,
    }),
    reason: partial.decision,
    requestedAmount: 5,
    executionStatus: "none",
    ...partial,
  };
}

const laterWorseBook = snapshot({
  timestamp: "2026-09-20T12:00:00.000Z",
  creditPrice: 0.85,
  discountPercent: 15,
});

const reviewed = record({
  id: "buy-review",
  decision: "BUY",
  executionStatus: "review",
  quotePrice: 0.8,
});
const reviewedOutcome = evaluateDecision(reviewed, laterWorseBook);
if (reviewedOutcome.resolved || reviewedOutcome.phase !== "execution") {
  throw new Error("Reviewed BUY must be an unresolved execution");
}
if (isConfirmedBuy(reviewed)) {
  throw new Error("Reviewed BUY must not count as confirmed");
}

const failed = record({
  id: "buy-fail",
  decision: "BUY",
  executionStatus: "failed",
  blockedReason: "rejected",
});
if (evaluateDecision(failed, laterWorseBook).useful !== null) {
  throw new Error("Failed BUY must not produce a useful score");
}

const pending = record({
  id: "buy-pending",
  decision: "BUY",
  executionStatus: "pending",
  txHash: "0xabc",
});
if (evaluateDecision(pending, laterWorseBook).phase !== "execution") {
  throw new Error("Pending BUY is execution, not confirmed");
}

const confirmedNoLater = record({
  id: "buy-confirmed",
  decision: "BUY",
  executionStatus: "success",
  creditAcquired: 5,
  totalUsdgPaid: 4,
  executionPrice: 0.8,
  confirmedAt: "2026-09-20T10:05:00.000Z",
});
const sameMoment = snapshot({
  timestamp: "2026-09-20T10:00:00.000Z",
  creditPrice: 0.82,
  discountPercent: 18,
});
const unresolvedConfirmed = evaluateDecision(confirmedNoLater, sameMoment);
if (unresolvedConfirmed.resolved || unresolvedConfirmed.phase !== "confirmed") {
  throw new Error("Confirmed BUY without a later book must stay unresolved");
}
if (unresolvedConfirmed.buyOnDemandCost != null) {
  throw new Error("Must not invent a buy-on-demand cost without a later book");
}

const laterCheaper = snapshot({
  timestamp: "2026-09-20T12:00:00.000Z",
  creditPrice: 0.75,
  discountPercent: 25,
});
const miss = evaluateDecision(confirmedNoLater, laterCheaper);
if (!miss.resolved || miss.useful !== false || miss.buyOnDemandCost !== 3.75) {
  throw new Error(`Expected unfavorable BUY outcome, got ${JSON.stringify(miss)}`);
}

const hit = evaluateDecision(confirmedNoLater, laterWorseBook);
if (!hit.resolved || hit.useful !== true) {
  throw new Error("BUY should be favorable when later listed price is higher");
}

const wait = record({
  id: "wait-1",
  decision: "WAIT",
  market: { price: 0.83, discountPercent: 17, availableDepth: 10 },
});
const waitLaterBetter = evaluateDecision(
  wait,
  snapshot({
    timestamp: "2026-09-20T12:00:00.000Z",
    creditPrice: 0.78,
    discountPercent: 22,
  }),
);
if (!waitLaterBetter.resolved || waitLaterBetter.useful !== true) {
  throw new Error("WAIT should note a later better listed discount");
}

const waitNoLater = evaluateDecision(wait, null);
if (waitNoLater.resolved || waitNoLater.phase !== "decision") {
  throw new Error("WAIT without a later book must be unresolved");
}

const summary = summarizePerformance(
  [reviewed, failed, pending, confirmedNoLater, wait],
  laterWorseBook,
);
if (summary.successfulExecutions !== 1) {
  throw new Error("Only confirmed fills belong in performance");
}
if (summary.totalCreditPurchased !== 5 || summary.totalProcurementCost !== 4) {
  throw new Error("Performance totals must use confirmed fill amounts");
}
if (summary.comparableBuyOnDemandCost !== buyOnDemandCost(5, laterWorseBook)) {
  throw new Error("Comparison must use later listed CREDIT price × size");
}

const noFill = summarizePerformance([reviewed, wait], laterWorseBook);
if (
  noFill.successfulExecutions !== 0 ||
  noFill.comparableBuyOnDemandCost !== null ||
  noFill.difference !== null
) {
  throw new Error("Zero confirmed fills must not invent a comparison");
}

console.log("outcomes + performance ok");
