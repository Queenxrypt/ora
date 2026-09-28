import { readFileSync } from "node:fs";
import type { DecisionRecord } from "../../types/ora";
import type { ObservationRow } from "../db/observations";
import {
  DEFAULT_OUTCOME_EVALUATION_WINDOW_MS,
  evaluateMarketOutcome,
} from "./outcome-engine";
import { COMPARISON_UNAVAILABLE, summarizePerformance } from "./performance";

function assert(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}

const ORIGIN = "2026-09-28T10:00:00.000Z";
const NOW_OPEN = Date.parse("2026-09-28T11:00:00.000Z");
const NOW_CLOSED = Date.parse("2026-09-28T22:00:01.000Z");

function snapshot(discount: number, timestamp = ORIGIN): DecisionRecord["snapshot"] {
  const price = Number((1 - discount / 100).toFixed(6));
  return {
    timestamp,
    creditPrice: price,
    discountPercent: discount,
    bestDiscount: discount,
    availableAtBestDiscount: 80,
    depth: [{ discountPercent: discount, availableCredit: 80 }],
    source: "orbio",
    totalAvailableCredit: 80,
    minBuyCredit: 5,
  };
}

function waitRecord(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    id: "wait-1",
    timestamp: ORIGIN,
    market: { price: 0.82, discountPercent: 18, availableDepth: 4 },
    snapshot: snapshot(18),
    decision: "WAIT",
    reason: "wait",
    minDiscountPercent: 20,
    evaluatedRequestedCredit: 5,
    executionStatus: "none",
    walletAddress: "0x63fc81ed1e1eab3e2906b578ccd3097970852a1b",
    ...overrides,
  };
}

function buyRecord(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    id: "buy-1",
    timestamp: ORIGIN,
    market: { price: 0.68, discountPercent: 32, availableDepth: 80 },
    snapshot: snapshot(32),
    decision: "BUY",
    reason: "buy",
    requestedAmount: 5,
    minDiscountPercent: 20,
    executionStatus: "success",
    executionPrice: 0.68,
    creditAcquired: 5,
    totalUsdgPaid: 3.4,
    confirmedAt: "2026-09-28T10:05:00.000Z",
    walletAddress: "0x63fc81ed1e1eab3e2906b578ccd3097970852a1b",
    ...overrides,
  };
}

function obs(
  slotStart: string,
  levels: ObservationRow["levels"],
  outcome: ObservationRow["outcome"] = "succeeded",
): ObservationRow {
  return {
    slot_start: slotStart,
    cadence_seconds: 300,
    outcome,
    attempted_at: slotStart,
    completed_at: outcome === "incomplete" ? null : slotStart,
    levels,
    min_buy_credit_atoms: 5_000_000,
    reported_total_credit_atoms: null,
    fingerprint: outcome === "succeeded" ? "v1:test" : null,
    http_status: outcome === "http_error" ? 503 : null,
    error_detail: null,
  };
}

function report(
  decisions: DecisionRecord[],
  rows: ObservationRow[],
  nowMs: number,
) {
  const outcomes = decisions.map((decision) =>
    evaluateMarketOutcome(decision, rows, nowMs, DEFAULT_OUTCOME_EVALUATION_WINDOW_MS),
  );
  return summarizePerformance(decisions, outcomes);
}

const qualifying = obs("2026-09-28T10:37:00.000Z", [
  { discount_bps: 3100, credit_atoms: 8_000_000 },
]);
const betterBuy = obs("2026-09-28T14:12:00.000Z", [
  { discount_bps: 3500, credit_atoms: 6_000_000 },
]);

const confirmed = report([buyRecord()], [], NOW_CLOSED);
assert(confirmed.procurement?.confirmedPurchases === 1, "1. confirmed purchase counts");
assert(confirmed.procurement?.creditPurchased === 5, "1. CREDIT purchased from the fill");
assert(confirmed.procurement?.usdgSpent === 3.4, "1. USDG spent from the fill");
assert(confirmed.procurement?.averageExecutionPrice === 0.68, "1. average execution price");
assert(confirmed.procurement?.averageExecutionDiscount === 32, "1. average execution discount");

const failed = report(
  [
    buyRecord({
      id: "buy-fail",
      executionStatus: "failed",
      creditAcquired: 5,
      totalUsdgPaid: 3.4,
    }),
  ],
  [],
  NOW_CLOSED,
);
assert(failed.procurement == null, "2. failed purchase does not contribute");
assert(failed.decisions.buyCount === 1, "2. failed BUY still counts as a decision");

const pendingBuy = report(
  [
    buyRecord({
      id: "buy-pending",
      executionStatus: "pending",
      creditAcquired: undefined,
      totalUsdgPaid: undefined,
      executionPrice: undefined,
    }),
  ],
  [],
  NOW_CLOSED,
);
assert(pendingBuy.procurement == null, "3. pending purchase does not contribute");

const mix = report(
  [buyRecord(), waitRecord(), waitRecord({ id: "wait-2", timestamp: "2026-09-28T10:05:00.000Z" })],
  [],
  NOW_CLOSED,
);
assert(mix.decisions.buyCount === 1, "4. BUY count");
assert(mix.decisions.waitCount === 2, "4. WAIT count");
assert(mix.decisions.total === 3, "4. total decisions");

const pendingWindow = report([waitRecord()], [qualifying], NOW_OPEN);
assert(pendingWindow.decisions.pendingOutcomes === 1, "5. pending Outcome Engine count");
assert(pendingWindow.decisions.completedOutcomes === 0, "5. not completed before 12 hours");
assert(pendingWindow.outcomes.pending === 1, "5. outcomes.pending");

const waitHit = report([waitRecord()], [qualifying], NOW_CLOSED);
assert(waitHit.outcomes.waitQualifying === 1, "6. WAIT qualifying opportunity");
assert(waitHit.outcomes.waitNone === 0, "6. not counted as none");
assert(
  waitHit.history[0]?.status === "Later qualifying opportunity",
  "6. history names the qualifying observation",
);

const waitMiss = report([waitRecord()], [], NOW_CLOSED);
assert(waitMiss.outcomes.waitNone === 1, "7. WAIT with no opportunity");
assert(waitMiss.outcomes.waitQualifying === 0, "7. not counted as qualifying");

const buyHit = report([buyRecord()], [betterBuy], NOW_CLOSED);
assert(buyHit.outcomes.buyBetter === 1, "8. BUY later better observed opportunity");
assert(buyHit.outcomes.buyNone === 0, "8. not counted as none");

const source = readFileSync(new URL("./performance.ts", import.meta.url), "utf8");
assert(!source.includes("buyOnDemandCost"), "9. no observation-derived dollar savings");
assert(!source.includes("would have saved"), "9. no savings copy");
assert(!source.includes("normalizeBook"), "9. does not reuse normalizeBook");
assert(waitHit.comparison.supported === false, "9. comparison is not invented");
assert(
  !("comparableBuyOnDemandCost" in waitHit) && !("difference" in waitHit),
  "9. no unsupported savings field",
);

assert(buyHit.comparison.supported === false, "10. buy-on-demand comparison is not shown as a number");
assert(
  buyHit.comparison.detail.includes("Not enough executable data yet"),
  "10. comparison states it is unsupported",
);

const empty = report([], [], NOW_CLOSED);
assert(!empty.hasDecisions && !empty.hasEvidence, "11. no decisions is insufficient");
assert(empty.procurement == null, "11. insufficient state does not invent procurement totals");
const building = report([waitRecord()], [qualifying], NOW_OPEN);
assert(building.hasDecisions && !building.hasEvidence, "11. pending windows are not enough evidence");
assert(building.procurement == null, "11. no zero procurement block while still building");

const currentSettings = { minDiscountPercent: 5, requestedCredit: 1, spendingLimitUsdg: 999 };
const ownCriteria = report(
  [waitRecord({ minDiscountPercent: 40, evaluatedRequestedCredit: 5 })],
  [qualifying],
  NOW_CLOSED,
);
assert(currentSettings.minDiscountPercent === 5, "12. current settings are unused");
assert(ownCriteria.outcomes.waitQualifying === 0, "12. WAIT uses the decision's saved minimum");
assert(ownCriteria.outcomes.waitNone === 1, "12. 31% does not meet the stored 40% minimum");

console.log("performance 2.0 checks passed");
