import { readFileSync } from "node:fs";
import type { ExecutableTerms, MarketSnapshot } from "../../types/ora";
import { recordToRow, rowToRecord } from "../db/rows";
import { decide, decideWithExecutableQuote, DEFAULT_PARAMS } from "./decision";

const thin: MarketSnapshot = {
  timestamp: "2026-09-19T00:00:00.000Z",
  creditPrice: 0.85,
  discountPercent: 15,
  bestDiscount: 15,
  availableAtBestDiscount: 3.35,
  depth: [{ discountPercent: 15, availableCredit: 3.35 }],
  source: "orbio",
  totalAvailableCredit: 3.35,
  minBuyCredit: 5,
};

const fillableAtThreshold: MarketSnapshot = {
  timestamp: "2026-09-19T00:00:00.000Z",
  creditPrice: 0.85,
  discountPercent: 15,
  bestDiscount: 15,
  availableAtBestDiscount: 5.8,
  depth: [{ discountPercent: 15, availableCredit: 5.8 }],
  source: "orbio",
  totalAvailableCredit: 5.8,
  minBuyCredit: 5,
};

const deep: MarketSnapshot = {
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

const params15 = { ...DEFAULT_PARAMS, minDiscountPercent: 15, requestedCredit: 5 };

const waitThin = decide(thin, params15);
if (waitThin.action !== "WAIT") {
  throw new Error("Expected WAIT when 15% has only 3.35 CREDIT vs requested 5");
}
if (!waitThin.reason.includes("3.35") || !waitThin.reason.includes("5")) {
  throw new Error(`WAIT reason should cite live size and request: ${waitThin.reason}`);
}

const buyFillable = decide(fillableAtThreshold, params15);
if (buyFillable.action !== "BUY" || buyFillable.requestedAmount !== 5) {
  throw new Error("Expected BUY when 15% has 5.8 CREDIT vs requested 5");
}

const waitBelowSize = decide(fillableAtThreshold, {
  ...params15,
  requestedCredit: 1,
});
if (waitBelowSize.action !== "BUY" || waitBelowSize.requestedAmount !== 5) {
  throw new Error(
    "Requested size below minBuyCredit must floor to minBuyCredit and BUY when that size can fill",
  );
}

const buy = decide(deep, DEFAULT_PARAMS);
if (buy.action !== "BUY" || buy.requestedAmount !== 5) {
  throw new Error("Expected BUY for 25% with depth");
}

const waitAgain = decide(deep, { ...DEFAULT_PARAMS, minDiscountPercent: 40 });
if (waitAgain.action !== "WAIT") {
  throw new Error("Expected WAIT when threshold is above the book");
}

const waitDefaultThin = decide(thin, DEFAULT_PARAMS);
if (waitDefaultThin.action !== "WAIT") {
  throw new Error("Expected WAIT on a 15% book against a 20% default threshold");
}

const qualifyingQuote: ExecutableTerms = {
  totalUsdg: 3.825,
  discountPercent: 23.5,
  creditOut: 5,
  requestedCredit: 5,
};

const qualified = decideWithExecutableQuote(deep, DEFAULT_PARAMS, qualifyingQuote);
if (qualified.action !== "BUY" || qualified.requestedAmount !== 5) {
  throw new Error("A: book and executable quote both qualify, so the decision is BUY");
}
if (!qualified.reason.includes("23.5%") || !qualified.reason.includes("3.825")) {
  throw new Error("A: BUY reason must cite the executable quote");
}
if (qualified.executable?.totalUsdg !== 3.825) {
  throw new Error("A: BUY must keep the executable terms that were checked");
}

const discountFail = decideWithExecutableQuote(
  deep,
  { ...DEFAULT_PARAMS, minDiscountPercent: 24 },
  qualifyingQuote,
);
if (discountFail.action === "BUY") {
  throw new Error("B: a qualifying book discount must not BUY when the executable discount fails");
}
if (!discountFail.reason.includes("23.5%") || !discountFail.reason.includes("24%")) {
  throw new Error(`B: WAIT reason should cite both discounts: ${discountFail.reason}`);
}

const limitFail = decideWithExecutableQuote(
  deep,
  { ...DEFAULT_PARAMS, spendingLimitUsdg: 3 },
  qualifyingQuote,
);
if (limitFail.action === "BUY") {
  throw new Error("C: executable cost above the spending limit must not BUY");
}
if (!limitFail.reason.includes("3.825") || !limitFail.reason.includes("3")) {
  throw new Error(`C: WAIT reason should cite cost and limit: ${limitFail.reason}`);
}

const floored = decideWithExecutableQuote(
  deep,
  { ...DEFAULT_PARAMS, requestedCredit: 1 },
  qualifyingQuote,
);
if (floored.action !== "BUY" || floored.requestedAmount !== 5) {
  throw new Error("D: requested size below minBuyCredit must floor before the quote is accepted");
}
const unflooredQuote: ExecutableTerms = { ...qualifyingQuote, requestedCredit: 1 };
const rejectedSize = decideWithExecutableQuote(
  deep,
  { ...DEFAULT_PARAMS, requestedCredit: 1 },
  unflooredQuote,
);
if (rejectedSize.action === "BUY") {
  throw new Error("D: a quote for the unfloored amount must not BUY");
}

const liquidQuote: ExecutableTerms = {
  totalUsdg: 4.25,
  discountPercent: 15,
  creditOut: 5,
  requestedCredit: 5,
};
const thinQuote = decideWithExecutableQuote(thin, params15, liquidQuote);
if (thinQuote.action !== "WAIT") {
  throw new Error("E: insufficient qualifying liquidity stays WAIT even if a quote is supplied");
}
if (thinQuote.executable) {
  throw new Error("E: a book WAIT must not be rewritten as an executable decision");
}

const unavailable = decideWithExecutableQuote(deep, DEFAULT_PARAMS, null);
if (unavailable.action === "BUY") {
  throw new Error("F: a missing executable quote must not produce BUY");
}
if (decide(deep, DEFAULT_PARAMS).action !== "BUY") {
  throw new Error("F: the book screen itself still reports BUY before the quote is known");
}

const emptyFill: ExecutableTerms = { ...qualifyingQuote, creditOut: 0 };
if (decideWithExecutableQuote(deep, DEFAULT_PARAMS, emptyFill).action === "BUY") {
  throw new Error("F: an executable quote with no CREDIT out must not BUY");
}

const roundTrip = rowToRecord(
  recordToRow({
    id: "quote-boundary",
    timestamp: qualified.timestamp,
    market: { price: 0.75, discountPercent: 25, availableDepth: 80 },
    snapshot: deep,
    decision: qualified.action,
    reason: qualified.reason,
    requestedAmount: qualified.requestedAmount,
    walletAddress: "0x63fc81ed1e1eab3e2906b578ccd3097970852a1b",
    executable: qualified.executable,
  }),
);
if (roundTrip.executable?.discountPercent !== 23.5 || roundTrip.executable.totalUsdg !== 3.825) {
  throw new Error("Executable terms must round-trip through the decision snapshot");
}
if ("decisionExecutable" in roundTrip.snapshot) {
  throw new Error("Executable terms must not remain on the market snapshot");
}

const decisionSource = readFileSync(
  new URL("../../app/api/decision/route.ts", import.meta.url),
  "utf8",
);
const unavailableAt = decisionSource.indexOf("Executable quote unavailable");
const appendAt = decisionSource.indexOf("appendDecision(");
if (!decisionSource.includes("quoteForCredit(book.requestedAmount)")) {
  throw new Error("Decision evaluation must quote the same requested amount");
}
if (unavailableAt < 0 || appendAt < 0 || unavailableAt > appendAt) {
  throw new Error("F: an unavailable quote must not be persisted as BUY");
}

const validateSource = readFileSync(
  new URL("../../app/api/execute/validate/route.ts", import.meta.url),
  "utf8",
);
const validateDecide = validateSource.indexOf("decide(market, settings)");
const validateQuote = validateSource.indexOf("quoteForCredit(requestedCredit)");
const validateLimit = validateSource.indexOf(
  "fresh.totalUsdg > settings.spendingLimitUsdg",
);
const validateDiscount = validateSource.indexOf(
  "quoteMeetsMinDiscount(fresh.discountPercent, settings.minDiscountPercent)",
);
const validateMoved = validateSource.indexOf("quotesMatch(body.quote, fresh)");
if (
  validateDecide < 0 ||
  validateQuote < 0 ||
  validateLimit < 0 ||
  validateDiscount < 0 ||
  validateMoved < 0 ||
  !(validateDecide < validateQuote && validateQuote < validateLimit && validateLimit < validateDiscount && validateDiscount < validateMoved)
) {
  throw new Error("G: pre-sign validation must still re-decide, re-quote, and reject limit, discount, and a moved quote");
}

console.log("decision engine ok");
console.log(waitThin.reason);
console.log(buyFillable.reason);
console.log(buy.reason);
