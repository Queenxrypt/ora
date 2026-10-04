import { decide, decideWithExecutableQuote, DEFAULT_PARAMS } from "./decision";
import {
  evaluateTarget,
  evaluationWrite,
  fillsRequestedCredit,
  isPurchaseInFlight,
  marketSnapshotFromObservedBook,
  paramsForTargetLinkedDecision,
  targetProcurementParams,
  validateTargetFields,
  type ConclusiveTargetEvaluation,
} from "./target";
import type { DecisionRecord, ExecutableTerms, MarketSnapshot } from "../../types/ora";
import { readFileSync } from "node:fs";

function assert(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}

const thin30: MarketSnapshot = {
  timestamp: "2026-09-29T12:00:00.000Z",
  creditPrice: 0.75,
  discountPercent: 25,
  bestDiscount: 25,
  availableAtBestDiscount: 30,
  depth: [
    { discountPercent: 25, availableCredit: 30 },
    { discountPercent: 10, availableCredit: 100 },
  ],
  source: "orbio",
  totalAvailableCredit: 130,
  minBuyCredit: 5,
};

const fillable50: MarketSnapshot = {
  timestamp: "2026-09-29T12:00:00.000Z",
  creditPrice: 0.75,
  discountPercent: 25,
  bestDiscount: 25,
  availableAtBestDiscount: 80,
  depth: [
    { discountPercent: 25, availableCredit: 80 },
    { discountPercent: 10, availableCredit: 100 },
  ],
  source: "orbio",
  totalAvailableCredit: 180,
  minBuyCredit: 5,
};

const splitDepth: MarketSnapshot = {
  timestamp: "2026-09-29T12:00:00.000Z",
  creditPrice: 0.75,
  discountPercent: 25,
  bestDiscount: 25,
  availableAtBestDiscount: 30,
  depth: [
    { discountPercent: 25, availableCredit: 30 },
    { discountPercent: 20, availableCredit: 25 },
  ],
  source: "orbio",
  totalAvailableCredit: 55,
  minBuyCredit: 5,
};

const target50 = {
  requestedCredit: 50,
  minDiscountPercent: 20,
  maxSpendUsdg: 40,
};

const passQuote: ExecutableTerms = {
  totalUsdg: 37.6,
  discountPercent: 24.8,
  creditOut: 50,
  requestedCredit: 50,
};

function quoteOf(terms: ExecutableTerms | null) {
  return async () => terms;
}

// Creation validation.
assert(validateTargetFields({ requestedCredit: 50, minDiscountPercent: 20, maxSpendUsdg: 40 }).ok, "valid target fields");
assert(!validateTargetFields({ requestedCredit: 0, minDiscountPercent: 20, maxSpendUsdg: 40 }).ok, "zero CREDIT rejected");
assert(!validateTargetFields({ requestedCredit: -1, minDiscountPercent: 20, maxSpendUsdg: 40 }).ok, "negative CREDIT rejected");
assert(!validateTargetFields({ requestedCredit: 50, minDiscountPercent: -1, maxSpendUsdg: 40 }).ok, "negative discount rejected");
assert(!validateTargetFields({ requestedCredit: 50, minDiscountPercent: 101, maxSpendUsdg: 40 }).ok, "discount over 100 rejected");
assert(!validateTargetFields({ requestedCredit: 50, minDiscountPercent: 20, maxSpendUsdg: 0 }).ok, "zero spend rejected");
assert(!validateTargetFields({ requestedCredit: "x", minDiscountPercent: 20, maxSpendUsdg: 40 }).ok, "non-numeric CREDIT rejected");

const params = targetProcurementParams(target50);
assert(params.spendingLimitUsdg === 40 && params.requestedCredit === 50, "target maps onto procurement params");

// Full-size requirement: 50 requested vs 30 at the qualifying level is WAIT.
const bookThin = decide(thin30, params);
assert(bookThin.action === "WAIT", "30 CREDIT at 25% cannot fill a 50 CREDIT target");
const evalThin = await evaluateTarget(thin30, target50, quoteOf(passQuote));
assert(evalThin.outcome === "NOT_QUALIFIED", "insufficient size is NOT_QUALIFIED");
assert(evalThin.status === "WATCHING" && evalThin.quoted === false, "insufficient size never quotes");
assert(evalThin.decision.action === "WAIT", "insufficient size is WAIT");

// Cumulative depth must not qualify.
const split = await evaluateTarget(splitDepth, target50, quoteOf(passQuote));
assert(split.status === "WATCHING" && split.quoted === false, "30+25 across levels is not a full-size fill");

// Qualifying book requests a quote.
let quotedAmount: number | null = null;
const evalFill = await evaluateTarget(fillable50, target50, async (amount) => {
  quotedAmount = amount;
  return passQuote;
});
assert(quotedAmount === 50, "quote is for the full requested amount");
assert(evalFill.outcome === "QUALIFIED", "passing executable quote is QUALIFIED");
assert(evalFill.status === "READY", "passing executable quote is READY");
assert(evalFill.quoted === true, "READY evaluation recorded a quote");
assert(evalFill.decision.executable?.totalUsdg === 37.6, "READY stores executable USDG, not book price");
assert(evalFill.decision.executable?.discountPercent === 24.8, "READY stores executable discount");

// Book qualifies, executable discount fails.
const lowDiscount = await evaluateTarget(fillable50, target50, quoteOf({
  ...passQuote,
  discountPercent: 19.9,
}));
assert(lowDiscount.outcome === "NOT_QUALIFIED", "executable discount miss is NOT_QUALIFIED");
assert(lowDiscount.status === "WATCHING" && lowDiscount.quoted === true, "executable discount miss stays WATCHING");
assert(lowDiscount.decision.action === "WAIT", "discount miss is WAIT after quote");

// Book qualifies, spend exceeds max.
const overSpend = await evaluateTarget(fillable50, target50, quoteOf({
  ...passQuote,
  totalUsdg: 40.01,
}));
assert(overSpend.outcome === "NOT_QUALIFIED" && overSpend.status === "WATCHING", "executable total above max spend stays WATCHING");

// Full target amount: a partial executable fill is never READY.
const partial = await evaluateTarget(fillable50, target50, quoteOf({
  ...passQuote,
  creditOut: 47,
  totalUsdg: 35.25,
}));
assert(partial.outcome === "NOT_QUALIFIED" && partial.status === "WATCHING", "50 CREDIT target with a 47 CREDIT quote is not READY");
assert(partial.decision.action === "WAIT", "partial fill is WAIT");
assert(partial.decision.reason.includes("47") && partial.decision.reason.includes("50"), "partial fill reason names both amounts");
assert(evaluationWrite(partial).lastExecutableTotalUsdg == null, "partial fill stores no READY quote");
const exact = await evaluateTarget(fillable50, target50, quoteOf({ ...passQuote, creditOut: 50 }));
assert(exact.outcome === "QUALIFIED", "50 CREDIT target with a 50 CREDIT quote is eligible");
assert(fillsRequestedCredit(50, 50) && fillsRequestedCredit(50.000001, 50), "full or larger fill passes");
assert(!fillsRequestedCredit(49.999999, 50), "one atom short fails");
assert(fillsRequestedCredit(0.1 + 0.2, 0.3), "float noise does not fail a full fill");

// READY only after executable quote passes — book-only never READY.
const bookOnly = await evaluateTarget(fillable50, target50);
assert(bookOnly.outcome === "INCONCLUSIVE" && bookOnly.quoted === false, "book BUY without a quote is INCONCLUSIVE, not READY");
assert(bookOnly.cause === "quote_skipped", "skipped quote is named");
assert(!("status" in bookOnly), "INCONCLUSIVE carries no target status");
assert(decide(fillable50, params).action === "BUY", "control: the book itself qualifies");

// Quote unavailable is INCONCLUSIVE, not market information.
const noQuote = await evaluateTarget(fillable50, target50, async () => null);
assert(noQuote.outcome === "INCONCLUSIVE" && noQuote.cause === "quote_unavailable", "missing quote is INCONCLUSIVE");

const threw = await evaluateTarget(fillable50, target50, async () => {
  throw new Error("rpc down");
});
assert(threw.outcome === "INCONCLUSIVE" && threw.cause === "quote_unavailable", "quote failure is INCONCLUSIVE");

// A book that cannot qualify needs no quote, so a broken quote never blocks WATCHING.
const thinBroken = await evaluateTarget(thin30, target50, async () => {
  throw new Error("rpc down");
});
assert(thinBroken.outcome === "NOT_QUALIFIED", "non-qualifying book is conclusive without a quote");

// Purchase-in-flight statuses.
assert(isPurchaseInFlight({ executionStatus: "awaiting_signature" }), "awaiting_signature is in flight");
assert(isPurchaseInFlight({ executionStatus: "pending" }), "pending is in flight");
for (const status of ["none", "review", "quoting", "success", "failed", "stale_quote", "blocked_liquidity"] as const) {
  assert(!isPurchaseInFlight({ executionStatus: status }), `${status} is not in flight`);
}
assert(!isPurchaseInFlight(null) && !isPurchaseInFlight({}), "no decision is not in flight");

// Repeated evaluation is deterministic.
const again = await evaluateTarget(fillable50, target50, quoteOf(passQuote));
assert(again.status === evalFill.status && again.decision.action === evalFill.decision.action, "repeat eval is stable");

// READY → WATCHING when the book no longer fills.
const reverted = await evaluateTarget(thin30, target50, quoteOf(passQuote));
assert(reverted.status === "WATCHING", "lost size returns to WATCHING");

const writeReady = evaluationWrite(evalFill as ConclusiveTargetEvaluation, new Date("2026-09-29T12:00:00.000Z"));
assert(writeReady.status === "READY", "write keeps READY");
assert(writeReady.lastExecutableTotalUsdg === 37.6, "write stores executable USDG");
assert(writeReady.lastExecutableDiscountPercent === 24.8, "write stores executable discount");
const writeWatch = evaluationWrite(reverted as ConclusiveTargetEvaluation, new Date("2026-09-29T12:01:00.000Z"));
assert(writeWatch.status === "WATCHING", "write keeps WATCHING");
assert(writeWatch.lastExecutableTotalUsdg == null, "WATCHING clears stored executable USDG");

// Observation book conversion is for the cheap screen only.
const observed = marketSnapshotFromObservedBook({
  levels: [{ discountBps: 2500, creditAtoms: 30_000_000 }],
  minBuyCreditAtoms: 5_000_000,
  reportedTotalCreditAtoms: 30_000_000,
});
assert(observed.bestDiscount === 25 && observed.availableAtBestDiscount === 30, "observed book maps depth");
assert(evaluateTarget.length >= 2, "evaluator is reusable");
const fromObserved = await evaluateTarget(observed, target50, quoteOf(passQuote));
assert(fromObserved.status === "WATCHING", "observed 30 CREDIT does not READY a 50 CREDIT target");

// Frozen target params ignore later settings.
const record: DecisionRecord = {
  id: "dec-target",
  timestamp: fillable50.timestamp,
  market: { price: 0.75, discountPercent: 25, availableDepth: 80 },
  snapshot: fillable50,
  decision: "BUY",
  reason: "target",
  requestedAmount: 50,
  walletAddress: "0x63fc81ed1e1eab3e2906b578ccd3097970852a1b",
  targetId: "tgt-1",
  minDiscountPercent: 20,
  evaluatedSpendingLimitUsdg: 40,
  executable: passQuote,
};
const frozen = paramsForTargetLinkedDecision(record);
assert(frozen != null && frozen.requestedCredit === 50 && frozen.spendingLimitUsdg === 40, "target freeze uses target params");
const laterSettings = { ...DEFAULT_PARAMS, requestedCredit: 5, spendingLimitUsdg: 25, minDiscountPercent: 5 };
assert(frozen!.spendingLimitUsdg !== laterSettings.spendingLimitUsdg, "settings changes do not unfreeze");
assert(paramsForTargetLinkedDecision({ ...record, targetId: undefined }) == null, "non-target rows are not frozen");
assert(
  decideWithExecutableQuote(fillable50, frozen!, passQuote).action === "BUY",
  "frozen params still BUY on a qualifying quote",
);

// Amount authority: evaluator quotes decide()'s requested amount, never a client size.
assert(evalFill.decision.requestedAmount === 50, "READY requested amount is the target size");

const quoteSource = readFileSync(new URL("../../app/api/quote/route.ts", import.meta.url), "utf8");
const validateSource = readFileSync(new URL("../../app/api/execute/validate/route.ts", import.meta.url), "utf8");
const reviewSource = readFileSync(new URL("../../app/api/targets/review/route.ts", import.meta.url), "utf8");
const observeSource = readFileSync(new URL("../../app/api/observe/route.ts", import.meta.url), "utf8");
const createSource = readFileSync(new URL("../../app/api/targets/route.ts", import.meta.url), "utf8");
const evalSource = readFileSync(new URL("../../app/api/targets/evaluate/route.ts", import.meta.url), "utf8");
const receiptSource = readFileSync(new URL("../../app/api/execute/receipt/route.ts", import.meta.url), "utf8");
const abortSource = readFileSync(new URL("../../app/api/execute/abort/route.ts", import.meta.url), "utf8");

function inOrder(source: string, label: string, needles: string[]) {
  let last = -1;
  for (const needle of needles) {
    const at = source.indexOf(needle);
    if (at < 0) throw new Error(`${label}: missing ${needle}`);
    if (at <= last) throw new Error(`${label}: ${needle} is out of order`);
    last = at;
  }
}

assert(!createSource.includes("writeSettings"), "create must not modify procurement settings");
assert(!evalSource.includes("appendDecision"), "evaluate must not create a decision");
assert(!observeSource.includes("appendDecision"), "observation must not create a decision");
inOrder(reviewSource, "review", [
  "targetPurchaseInFlight(access.target)",
  "evaluateTarget(",
  'evaluation.outcome === "INCONCLUSIVE"',
  "persistTargetEvaluation(access.target, evaluation)",
  "appendDecision(",
  'executionStatus: "none"',
]);
inOrder(quoteSource, "quote full fill", [
  "quoteForCredit(requestedCredit)",
  "fillsRequestedCredit(quote.creditOut, requestedCredit)",
  "quote.totalUsdg > params.spendingLimitUsdg",
]);
inOrder(validateSource, "validate active purchase", [
  "paramsForTargetLinkedDecision(current)",
  "linked.target.activeDecisionId !== current.id",
  "quoteForCredit(requestedCredit)",
  "fillsRequestedCredit(fresh.creditOut, requestedCredit)",
  "fresh.totalUsdg > params.spendingLimitUsdg",
]);
assert(!reviewSource.includes("/api/targets/buy"), "no second buy route");
inOrder(quoteSource, "frozen quote", [
  "recordedQuoteAmount(access.record)",
  "paramsForTargetLinkedDecision(access.record)",
  "const params = frozen ?? settings",
  "decide(market, params)",
  "quoteForCredit(requestedCredit)",
  "quote.totalUsdg > params.spendingLimitUsdg",
]);
inOrder(validateSource, "frozen validate", [
  "paramsForTargetLinkedDecision(current)",
  "const params = frozen ?? settings",
  "decide(market, params)",
  "fresh.totalUsdg > params.spendingLimitUsdg",
  "quoteMeetsMinDiscount(fresh.discountPercent, params.minDiscountPercent)",
]);
assert(receiptSource.includes("tryFulfillTargetFromDecision"), "receipt fulfillment is wired");
assert(abortSource.includes("tryReopenTargetFromDecision"), "abort reopens the target");
assert(!validateSource.includes("tryFulfillTargetFromDecision"), "validate never fulfills a target");
assert(observeSource.includes("evaluateOpenTargetsAfterObservation"), "observation evaluates targets");
assert(
  !observeSource.includes("lib/ora/decision") &&
    !observeSource.includes("quoteForCredit") &&
    !observeSource.includes("types/ora"),
  "observe route stays isolated; target eval is behind the watcher",
);

console.log("target evaluator ok");
