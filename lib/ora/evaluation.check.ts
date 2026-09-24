import { readFileSync } from "node:fs";
import type {
  DecisionRecord,
  ExecutableTerms,
  MarketSnapshot,
  OraDecision,
} from "../../types/ora";
import { decide, decideWithExecutableQuote, DEFAULT_PARAMS } from "./decision";
import { recordToRow, rowToRecord } from "../db/rows";
import {
  canReviewDecision,
  evaluationKey,
  nextEvaluationAction,
  sameRecordedEvaluation,
  settingsReadyForEvaluation,
  shouldRequestQuote,
} from "./evaluation";
import {
  finalDecisionAction,
  resolveAdvisoryReasoning,
} from "./reasoning";

const wallet = "0x63fc81ed1e1eab3e2906b578ccd3097970852a1b";
const otherWallet = "0x1111111111111111111111111111111111111111";
const saved = { ...DEFAULT_PARAMS, walletAddress: wallet };

const buyBook: MarketSnapshot = {
  timestamp: "2026-09-19T00:00:00.000Z",
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

const waitBook: MarketSnapshot = {
  ...buyBook,
  creditPrice: 0.85,
  discountPercent: 15,
  bestDiscount: 15,
  availableAtBestDiscount: 80,
  depth: [{ discountPercent: 15, availableCredit: 80 }],
};

function recordFor(
  decision: OraDecision,
  market: MarketSnapshot,
): DecisionRecord {
  return {
    id: "dec-1",
    timestamp: decision.timestamp,
    market: {
      price: market.creditPrice,
      discountPercent: market.discountPercent,
      availableDepth: market.availableAtBestDiscount,
    },
    snapshot: market,
    decision: decision.action,
    reason: decision.reason,
    requestedAmount: decision.requestedAmount,
    executionStatus: "none",
    walletAddress: wallet,
  };
}

const buy = decide(buyBook, DEFAULT_PARAMS);
const wait = decide(waitBook, DEFAULT_PARAMS);
if (buy.action !== "BUY" || wait.action !== "WAIT") {
  throw new Error("Fixtures must produce BUY and WAIT");
}

const firstBuy = nextEvaluationAction({
  wallet,
  market: buyBook,
  params: saved,
  lastKey: null,
  inFlightKey: null,
  latest: null,
});
if (firstBuy.type !== "persist") {
  throw new Error("A: BUY evaluation must be persisted once");
}

const firstWait = nextEvaluationAction({
  wallet,
  market: waitBook,
  params: saved,
  lastKey: null,
  inFlightKey: null,
  latest: null,
});
if (firstWait.type !== "persist") {
  throw new Error("B: WAIT evaluation must be persisted once");
}

const rerender = nextEvaluationAction({
  wallet,
  market: buyBook,
  params: saved,
  lastKey: firstBuy.key,
  inFlightKey: null,
  latest: recordFor(buy, buyBook),
});
if (rerender.type !== "skip" || rerender.reason !== "duplicate") {
  throw new Error("C: re-rendering the same evaluation must not create another decision");
}

const limitOnly = nextEvaluationAction({
  wallet,
  market: buyBook,
  params: {
    ...saved,
    spendingLimitUsdg: saved.spendingLimitUsdg + 1,
  },
  lastKey: firstBuy.key,
  inFlightKey: null,
  latest: recordFor(buy, buyBook),
});
if (limitOnly.type !== "persist") {
  throw new Error("B: a spending-limit-only change must be a new evaluation");
}

const remount = nextEvaluationAction({
  wallet,
  market: buyBook,
  params: saved,
  lastKey: null,
  inFlightKey: null,
  latest: recordFor(buy, buyBook),
});
if (remount.type !== "adopt") {
  throw new Error("C: an already recorded evaluation must be reused");
}

const inFlight = nextEvaluationAction({
  wallet,
  market: waitBook,
  params: saved,
  lastKey: null,
  inFlightKey: firstWait.key,
  latest: null,
});
if (inFlight.type !== "skip" || inFlight.reason !== "in-flight") {
  throw new Error("C: an in-flight evaluation must not be persisted twice");
}

const disconnected = nextEvaluationAction({
  wallet: null,
  market: waitBook,
  params: saved,
  lastKey: null,
  inFlightKey: null,
  latest: null,
});
if (disconnected.type !== "skip" || disconnected.reason !== "disconnected") {
  throw new Error("A disconnected desk must not persist a decision");
}

if (shouldRequestQuote(wait.action) !== false) {
  throw new Error("D: WAIT must not request a quote");
}
if (shouldRequestQuote(null) !== false) {
  throw new Error("D: a missing action must not request a quote");
}
if (shouldRequestQuote(buy.action) !== true) {
  throw new Error("E: BUY must still be able to request a quote");
}

let reasoningCalls = 0;
const seen: string[] = [];
for (const decision of [buy, wait]) {
  const reasoning = await resolveAdvisoryReasoning(decision, async (input) => {
    reasoningCalls += 1;
    seen.push(input.action);
    return {
      recommendation: input.action,
      rationale: "Noted.",
      risks: [],
      agreesWithRule: true,
    };
  });
  if (!reasoning) throw new Error("F: reasoning must be requested");
  if (finalDecisionAction(decision, reasoning) !== decision.action) {
    throw new Error("H: reasoning must not change the deterministic action");
  }
}
if (reasoningCalls !== 2 || seen.join(",") !== "BUY,WAIT") {
  throw new Error("F: reasoning must be requested for both BUY and WAIT");
}

const failed = await resolveAdvisoryReasoning(wait, async () => {
  throw new Error("gateway down");
});
if (failed !== null) {
  throw new Error("G: reasoning failure must not invent a reasoning result");
}
if (wait.action !== "WAIT") {
  throw new Error("G: reasoning failure must not prevent the WAIT decision");
}

const disagreement = {
  recommendation: "BUY" as const,
  rationale: "I would buy.",
  risks: [],
  agreesWithRule: false,
};
if (finalDecisionAction(wait, disagreement) !== "WAIT") {
  throw new Error("H: a disagreeing model must not override WAIT");
}
if (finalDecisionAction(buy, { ...disagreement, recommendation: "WAIT" }) !== "BUY") {
  throw new Error("H: a disagreeing model must not override BUY");
}

const noWallet = nextEvaluationAction({
  wallet: null,
  market: buyBook,
  params: saved,
  lastKey: null,
  inFlightKey: null,
  latest: null,
});
if (noWallet.type !== "skip" || noWallet.reason !== "disconnected") {
  throw new Error("connect A: no wallet must not persist");
}

if (settingsReadyForEvaluation(otherWallet, saved)) {
  throw new Error("connect B: a new wallet must not keep the previous committed settings");
}
const switched = nextEvaluationAction({
  wallet: otherWallet,
  market: buyBook,
  params: saved,
  lastKey: null,
  inFlightKey: null,
  latest: null,
});
if (switched.type !== "skip" || switched.reason !== "settings-unready") {
  throw new Error("connect B: evaluation must wait until the new wallet's settings are ready");
}

const defaults = nextEvaluationAction({
  wallet,
  market: buyBook,
  params: DEFAULT_PARAMS,
  lastKey: null,
  inFlightKey: null,
  latest: null,
});
if (defaults.type !== "skip" || defaults.reason !== "settings-unready") {
  throw new Error("connect C: disconnected defaults must not persist after connection");
}

const walletSaved = {
  ...DEFAULT_PARAMS,
  requestedCredit: 12,
  walletAddress: wallet,
};
const firstForWallet = nextEvaluationAction({
  wallet,
  market: buyBook,
  params: walletSaved,
  lastKey: null,
  inFlightKey: null,
  latest: null,
});
if (firstForWallet.type !== "persist" || !firstForWallet.key.includes("~12~")) {
  throw new Error("connect D: the first decision must use that wallet's saved settings");
}

const confirmed = recordFor(buy, buyBook);
confirmed.executionStatus = "success";
confirmed.creditAcquired = 5;
confirmed.totalUsdgPaid = 3.825;
const reuseConfirmed = nextEvaluationAction({
  wallet,
  market: buyBook,
  params: saved,
  lastKey: null,
  inFlightKey: null,
  latest: confirmed,
});
if (reuseConfirmed.type !== "skip" || reuseConfirmed.reason !== "terminal") {
  throw new Error("connect E: a confirmed decision must not be adopted");
}
if (canReviewDecision(confirmed)) {
  throw new Error("connect F: review must not requote a confirmed decision");
}
const quoteSource = readFileSync(
  new URL("../../app/api/quote/route.ts", import.meta.url),
  "utf8",
);
if (!quoteSource.includes("canReviewDecision")) {
  throw new Error("connect F: the quote route must refuse a finished decision");
}

const failedRow = recordFor(wait, waitBook);
failedRow.executionStatus = "failed";
const reuseFailed = nextEvaluationAction({
  wallet,
  market: waitBook,
  params: saved,
  lastKey: null,
  inFlightKey: null,
  latest: failedRow,
});
if (reuseFailed.type !== "skip" || reuseFailed.reason !== "terminal") {
  throw new Error("connect E: a failed decision must not be reopened");
}
if (confirmed.executionStatus !== "success" || failedRow.executionStatus !== "failed") {
  throw new Error("connect G: a terminal decision must remain unchanged in history");
}

const afterConfirm = nextEvaluationAction({
  wallet,
  market: waitBook,
  params: saved,
  lastKey: null,
  inFlightKey: null,
  latest: confirmed,
});
if (afterConfirm.type !== "persist") {
  throw new Error("connect H: a new market evaluation must still be persisted after a confirmed purchase");
}

const terms: ExecutableTerms = {
  totalUsdg: 3.825,
  discountPercent: 23.5,
  creditOut: 5,
  requestedCredit: 5,
};
const quotedBuy = decideWithExecutableQuote(buyBook, DEFAULT_PARAMS, terms);
const quotedRow = recordFor(quotedBuy, buyBook);
quotedRow.executable = quotedBuy.executable;
quotedRow.evaluatedSpendingLimitUsdg = saved.spendingLimitUsdg;

const raisedLimit = { ...saved, spendingLimitUsdg: saved.spendingLimitUsdg + 1 };
if (evaluationKey(wallet, buyBook, saved) !== evaluationKey(wallet, buyBook, { ...saved })) {
  throw new Error("A: same market, settings, and spending limit must give the same key");
}
if (evaluationKey(wallet, buyBook, saved) === evaluationKey(wallet, buyBook, raisedLimit)) {
  throw new Error("B: a different spending limit must give a different key");
}
if (decideWithExecutableQuote(buyBook, raisedLimit, terms).action !== "BUY") {
  throw new Error("B: fixture must stay BUY under the raised limit");
}

const limitStillBuy = nextEvaluationAction({
  wallet,
  market: buyBook,
  params: raisedLimit,
  lastKey: firstBuy.key,
  inFlightKey: null,
  latest: quotedRow,
});
if (limitStillBuy.type !== "persist") {
  throw new Error("B: a spending-limit change must re-evaluate even when BUY would remain BUY");
}

const remountRaised = nextEvaluationAction({
  wallet,
  market: buyBook,
  params: raisedLimit,
  lastKey: null,
  inFlightKey: null,
  latest: quotedRow,
});
if (remountRaised.type !== "persist") {
  throw new Error("C: a row checked against another spending limit must not be adopted");
}
if (sameRecordedEvaluation(quotedRow, buyBook, raisedLimit)) {
  throw new Error("C: a row checked against another spending limit is not the same evaluation");
}
const legacyQuoted = { ...quotedRow, evaluatedSpendingLimitUsdg: undefined };
if (sameRecordedEvaluation(legacyQuoted, buyBook, saved)) {
  throw new Error("C: a quote-backed row without its spending limit must be re-quoted");
}

const decisionRoute = readFileSync(
  new URL("../../app/api/decision/route.ts", import.meta.url),
  "utf8",
);
if (
  !decisionRoute.includes("readSettings(wallet)") ||
  !decisionRoute.includes("quoteForCredit(book.requestedAmount)") ||
  !decisionRoute.includes("decideWithExecutableQuote(market, settings")
) {
  throw new Error("C: a persisted evaluation must quote against the saved spending limit");
}

const raisedKey = evaluationKey(wallet, buyBook, raisedLimit);
const rerenderRaised = nextEvaluationAction({
  wallet,
  market: buyBook,
  params: raisedLimit,
  lastKey: raisedKey,
  inFlightKey: null,
  latest: { ...quotedRow, evaluatedSpendingLimitUsdg: raisedLimit.spendingLimitUsdg },
});
if (rerenderRaised.type !== "skip" || rerenderRaised.reason !== "duplicate") {
  throw new Error("D: re-rendering with the same spending limit must not duplicate the row");
}
const inFlightRaised = nextEvaluationAction({
  wallet,
  market: buyBook,
  params: raisedLimit,
  lastKey: firstBuy.key,
  inFlightKey: raisedKey,
  latest: quotedRow,
});
if (inFlightRaised.type !== "skip" || inFlightRaised.reason !== "in-flight") {
  throw new Error("D: an in-flight spending-limit evaluation must not be persisted twice");
}

const stored = rowToRecord(recordToRow(quotedRow));
if (stored.evaluatedSpendingLimitUsdg !== saved.spendingLimitUsdg) {
  throw new Error("The evaluated spending limit must round-trip through the store");
}
if ("decisionSpendingLimitUsdg" in stored.snapshot) {
  throw new Error("The evaluated spending limit must not remain on the market snapshot");
}

const limitBlocks = nextEvaluationAction({
  wallet,
  market: buyBook,
  params: { ...saved, spendingLimitUsdg: 3 },
  lastKey: firstBuy.key,
  inFlightKey: null,
  latest: quotedRow,
});
if (limitBlocks.type !== "persist") {
  throw new Error("C: executable cost above the spending limit must be re-evaluated");
}

const blocked = decideWithExecutableQuote(
  buyBook,
  { ...DEFAULT_PARAMS, spendingLimitUsdg: 3 },
  terms,
);
const blockedRow = recordFor(blocked, buyBook);
blockedRow.executable = blocked.executable;
blockedRow.evaluatedSpendingLimitUsdg = 3;
if (blocked.action !== "WAIT") {
  throw new Error("H: a quote over the spending limit must be a WAIT decision");
}
const adoptWait = nextEvaluationAction({
  wallet,
  market: buyBook,
  params: { ...saved, spendingLimitUsdg: 3 },
  lastKey: null,
  inFlightKey: null,
  latest: blockedRow,
});
if (adoptWait.type !== "adopt") {
  throw new Error("H: a quote-backed WAIT must be reused on remount");
}

const adoptBuy = nextEvaluationAction({
  wallet,
  market: buyBook,
  params: saved,
  lastKey: null,
  inFlightKey: null,
  latest: quotedRow,
});
if (adoptBuy.type !== "adopt" || quotedBuy.action !== "BUY") {
  throw new Error("I: a quote-backed BUY must be reused on remount");
}

let reasoned: string | null = null;
const advisory = await resolveAdvisoryReasoning(blocked, async (input) => {
  reasoned = input.action;
  return {
    recommendation: input.action,
    rationale: "The executable cost is over the limit.",
    risks: [],
    agreesWithRule: true,
  };
});
if (reasoned !== "WAIT" || advisory?.recommendation !== "WAIT") {
  throw new Error("J: reasoning must follow the corrected WAIT");
}
if (
  finalDecisionAction(blocked, {
    recommendation: "BUY",
    rationale: "Buy anyway.",
    risks: [],
    agreesWithRule: false,
  }) !== "WAIT"
) {
  throw new Error("J: reasoning must not override the corrected WAIT");
}
const buyAdvisory = await resolveAdvisoryReasoning(quotedBuy, async (input) => {
  if (input.action !== "BUY") {
    throw new Error("J: reasoning must follow the corrected BUY");
  }
  return {
    recommendation: input.action,
    rationale: "The executable quote clears the rule.",
    risks: [],
    agreesWithRule: true,
  };
});
if (
  !buyAdvisory ||
  finalDecisionAction(quotedBuy, {
    recommendation: "WAIT",
    rationale: "Wait anyway.",
    risks: [],
    agreesWithRule: false,
  }) !== "BUY"
) {
  throw new Error("J: reasoning must not override the corrected BUY");
}

console.log("evaluation persistence ok");
