import { readFileSync } from "node:fs";
import type { DecisionRecord } from "../../types/ora";
import type { ObservationRow } from "../db/observations";
import {
  DEFAULT_OUTCOME_EVALUATION_WINDOW_MS,
  afterMarketView,
  evaluateMarketOutcome,
  formatElapsedDuration,
  observationInWindow,
} from "./outcome-engine";

function assert(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}

const ORIGIN = "2026-09-28T10:00:00.000Z";
const ORIGIN_MS = Date.parse(ORIGIN);
const WINDOW = DEFAULT_OUTCOME_EVALUATION_WINDOW_MS;
const WINDOW_END = "2026-09-28T22:00:00.000Z";
const AFTER_WINDOW = "2026-09-28T22:00:00.001Z";
const NOW_OPEN = Date.parse("2026-09-28T11:00:00.000Z");
const NOW_CLOSED = Date.parse("2026-09-28T22:00:01.000Z");

assert(
  WINDOW === 12 * 60 * 60 * 1000,
  "default evaluation window is 12 hours",
);
assert(
  observationInWindow(WINDOW_END, ORIGIN_MS, ORIGIN_MS + WINDOW),
  "exact 12-hour cutoff is included",
);
assert(
  !observationInWindow(AFTER_WINDOW, ORIGIN_MS, ORIGIN_MS + WINDOW),
  "one millisecond after 12 hours is excluded",
);
assert(
  !observationInWindow(ORIGIN, ORIGIN_MS, ORIGIN_MS + WINDOW),
  "the decision timestamp itself is not a later observation",
);

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

function waitRecord(
  overrides: Partial<DecisionRecord> = {},
): DecisionRecord {
  return {
    id: "wait-1",
    timestamp: ORIGIN,
    market: { price: 0.82, discountPercent: 18, availableDepth: 4 },
    snapshot: {
      timestamp: ORIGIN,
      creditPrice: 0.82,
      discountPercent: 18,
      bestDiscount: 18,
      availableAtBestDiscount: 4,
      depth: [{ discountPercent: 18, availableCredit: 4 }],
      source: "orbio",
      totalAvailableCredit: 4,
      minBuyCredit: 5,
    },
    decision: "WAIT",
    reason: "Best available discount is 18%, below your 20% threshold.",
    minDiscountPercent: 20,
    evaluatedRequestedCredit: 5,
    executionStatus: "none",
    walletAddress: "0x63fc81ed1e1eab3e2906b578ccd3097970852a1b",
    ...overrides,
  };
}

function buyRecord(
  overrides: Partial<DecisionRecord> = {},
): DecisionRecord {
  return {
    id: "buy-1",
    timestamp: ORIGIN,
    market: { price: 0.68, discountPercent: 32, availableDepth: 80 },
    snapshot: {
      timestamp: ORIGIN,
      creditPrice: 0.68,
      discountPercent: 32,
      bestDiscount: 32,
      availableAtBestDiscount: 80,
      depth: [{ discountPercent: 32, availableCredit: 80 }],
      source: "orbio",
      totalAvailableCredit: 80,
      minBuyCredit: 5,
    },
    decision: "BUY",
    reason: "32% discount meets your 20% threshold and enough CREDIT is available to fulfill your 5 CREDIT request.",
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

const laterQualifying = obs("2026-09-28T10:37:00.000Z", [
  { discount_bps: 3100, credit_atoms: 8_000_000 },
]);
const laterThinHigh = obs("2026-09-28T10:40:00.000Z", [
  { discount_bps: 3500, credit_atoms: 1 },
  { discount_bps: 1800, credit_atoms: 8_000_000 },
]);
const laterAfterWindow = obs(AFTER_WINDOW, [
  { discount_bps: 4000, credit_atoms: 9_000_000 },
]);
const failedHigh = obs(
  "2026-09-28T10:20:00.000Z",
  null,
  "http_error",
);
const laterBetterBuy = obs("2026-09-28T14:12:00.000Z", [
  { discount_bps: 3500, credit_atoms: 6_000_000 },
]);
const laterWorseBuy = obs("2026-09-28T12:00:00.000Z", [
  { discount_bps: 3000, credit_atoms: 9_000_000 },
]);

const waitHit = evaluateMarketOutcome(
  waitRecord(),
  [laterQualifying],
  NOW_CLOSED,
);
assert(waitHit.lifecycle === "final", "1. WAIT window is closed");
assert(waitHit.firstQualifyingOpportunity?.observedDiscountPercent === 31, "1. WAIT records the observed discount");
assert(waitHit.firstQualifyingOpportunity?.observedAt === "2026-09-28T10:37:00.000Z", "1. WAIT records the first qualifying timestamp");
assert(waitHit.firstQualifyingOpportunity?.elapsedMs === 37 * 60_000, "1. WAIT records elapsed time");
assert(
  afterMarketView(waitHit)?.headline === "Later qualifying opportunity",
  "1. WAIT copy names a later qualifying opportunity",
);
assert(
  !JSON.stringify(waitHit).includes("saved") &&
    !JSON.stringify(afterMarketView(waitHit)).toLowerCase().includes("bought for"),
  "1. WAIT does not invent an executable purchase",
);

const waitMiss = evaluateMarketOutcome(waitRecord(), [], NOW_CLOSED);
assert(waitMiss.lifecycle === "final", "2. WAIT with no later rows still finalizes after 12 hours");
assert(waitMiss.firstQualifyingOpportunity == null, "2. WAIT records that none appeared");
assert(
  afterMarketView(waitMiss)?.headline === "No qualifying opportunity observed",
  "2. WAIT copy does not call this a failure",
);

const waitLate = evaluateMarketOutcome(
  waitRecord(),
  [laterAfterWindow],
  NOW_CLOSED,
);
assert(waitLate.firstQualifyingOpportunity == null, "3. WAIT ignores opportunities after 12 hours");

const waitThinThenFill = evaluateMarketOutcome(
  waitRecord(),
  [laterThinHigh, laterQualifying],
  NOW_CLOSED,
);
assert(
  waitThinThenFill.firstQualifyingOpportunity?.observedAt ===
    "2026-09-28T10:37:00.000Z",
  "4. WAIT uses the first later observation that actually has CREDIT depth",
);

const buyThinHigh = evaluateMarketOutcome(
  buyRecord(),
  [laterThinHigh],
  NOW_CLOSED,
);
assert(
  buyThinHigh.betterObservedOpportunity == null,
  "BUY does not treat a 1-atom higher discount as a better observed opportunity",
);

const unusedCurrentMin = 5;
const waitOwnCriteria = evaluateMarketOutcome(
  waitRecord({ minDiscountPercent: 40, evaluatedRequestedCredit: 5 }),
  [laterQualifying],
  NOW_CLOSED,
);
assert(
  unusedCurrentMin === 5 && waitOwnCriteria.firstQualifyingOpportunity == null,
  "5. WAIT uses the decision's saved minimum, not a later setting",
);

const buyHit = evaluateMarketOutcome(
  buyRecord(),
  [laterWorseBuy, laterBetterBuy],
  NOW_CLOSED,
);
assert(buyHit.lifecycle === "final" && buyHit.applicable, "6. confirmed BUY is evaluated");
assert(buyHit.purchaseDiscountPercent === 32, "6. BUY uses the execution discount");
assert(buyHit.betterObservedOpportunity?.observedDiscountPercent === 35, "6. BUY records the best later observed discount");
assert(
  buyHit.betterObservedOpportunity?.elapsedMs === 4 * 60 * 60_000 + 12 * 60_000,
  "6. BUY records elapsed time until that opportunity",
);
assert(
  afterMarketView(buyHit)?.headline === "Later observed opportunity",
  "6. BUY copy names a later observed opportunity",
);

const buyMiss = evaluateMarketOutcome(buyRecord(), [laterWorseBuy], NOW_CLOSED);
assert(buyMiss.betterObservedOpportunity == null, "7. BUY records when nothing better was observed");
assert(
  afterMarketView(buyMiss)?.headline === "No better observed opportunity",
  "7. BUY does not call this a loss",
);

const waitPending = evaluateMarketOutcome(
  waitRecord(),
  [laterQualifying],
  NOW_OPEN,
);
assert(waitPending.lifecycle === "pending", "8. WAIT stays pending before 12 hours");
assert(
  afterMarketView(waitPending)?.headline ===
    "The 12-hour evaluation window is still open.",
  "8. pending UI does not finalize",
);

const buyPending = evaluateMarketOutcome(
  buyRecord(),
  [laterBetterBuy],
  NOW_OPEN,
);
assert(buyPending.lifecycle === "pending", "8. BUY stays pending before 12 hours");

const waitFailedIgnored = evaluateMarketOutcome(
  waitRecord(),
  [failedHigh, laterQualifying],
  NOW_CLOSED,
);
assert(
  waitFailedIgnored.firstQualifyingOpportunity?.observedAt ===
    "2026-09-28T10:37:00.000Z",
  "9. failed observations are not market data",
);

const waitExactCutoff = evaluateMarketOutcome(
  waitRecord(),
  [obs(WINDOW_END, [{ discount_bps: 2500, credit_atoms: 5_000_000 }])],
  NOW_CLOSED,
);
assert(
  waitExactCutoff.firstQualifyingOpportunity?.observedAt === WINDOW_END,
  "10. an observation exactly at 12 hours counts",
);
const waitPastCutoff = evaluateMarketOutcome(
  waitRecord(),
  [obs(AFTER_WINDOW, [{ discount_bps: 2500, credit_atoms: 5_000_000 }])],
  NOW_CLOSED,
);
assert(
  waitPastCutoff.firstQualifyingOpportunity == null,
  "10. an observation after 12 hours does not count",
);

const engineSource = readFileSync(new URL("./outcome-engine.ts", import.meta.url), "utf8");
assert(!engineSource.includes("buyOnDemandCost"), "11. observations are not turned into a buy-on-demand cost");
assert(!engineSource.includes("would have saved"), "11. no invented savings copy");
assert(!engineSource.includes("could have bought"), "11. no invented executable fill");
assert(!engineSource.includes("normalizeBook"), "11. history path does not reuse normalizeBook");
assert(
  buyHit.betterObservedOpportunity != null &&
    !("buyOnDemandCost" in buyHit) &&
    !("costDifference" in buyHit),
  "11. BUY outcome has no invented executable price",
);

assert(formatElapsedDuration(37 * 60_000) === "37 minutes", "elapsed minutes format");
assert(formatElapsedDuration(4 * 60 * 60_000 + 12 * 60_000) === "4 hours 12 minutes", "elapsed hours format");

const waitLegacy = evaluateMarketOutcome(
  waitRecord({ minDiscountPercent: undefined, evaluatedRequestedCredit: undefined }),
  [laterQualifying],
  NOW_CLOSED,
);
assert(waitLegacy.firstQualifyingOpportunity == null, "legacy WAIT does not invent qualification");
assert(
  afterMarketView(waitLegacy)?.headline === "Decision criteria were not stored",
  "legacy WAIT does not manufacture a no-opportunity result",
);

const unconfirmed = evaluateMarketOutcome(
  buyRecord({
    executionStatus: "review",
    creditAcquired: undefined,
    totalUsdgPaid: undefined,
    executionPrice: undefined,
  }),
  [laterBetterBuy],
  NOW_CLOSED,
);
assert(unconfirmed.applicable === false, "unconfirmed BUY is not evaluated against later books");
assert(afterMarketView(unconfirmed) == null, "unconfirmed BUY does not add after-market copy");

const observeSource = readFileSync(
  new URL("../../app/api/observe/route.ts", import.meta.url),
  "utf8",
);
assert(!observeSource.includes("evaluateMarketOutcome"), "/api/observe stays the writer");

const decisionSource = readFileSync(
  new URL("./decision.ts", import.meta.url),
  "utf8",
);
assert(!decisionSource.includes("evaluateMarketOutcome"), "BUY/WAIT rule is unchanged");

console.log("outcome engine checks passed");
