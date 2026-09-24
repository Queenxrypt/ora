import { readFileSync } from "node:fs";
import type { DecisionRecord, MarketSnapshot } from "../../types/ora";
import { recordBelongsToWallet } from "../db/store";
import { decide, DEFAULT_PARAMS } from "./decision";
import { canReviewDecision } from "./evaluation";
import { checkAmountAgainstMarket, recordedQuoteAmount } from "./quote-amount";
import { quoteMeetsMinDiscount } from "./quote-rule";

const wallet = "0x63fc81ed1e1eab3e2906b578ccd3097970852a1b";
const otherWallet = "0x1111111111111111111111111111111111111111";

const book: MarketSnapshot = {
  timestamp: "2026-09-23T00:00:00.000Z",
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

function buyRecord(requestedAmount: number | undefined): DecisionRecord {
  return {
    id: "dec-amount",
    timestamp: book.timestamp,
    market: { price: 0.75, discountPercent: 25, availableDepth: 80 },
    snapshot: book,
    decision: "BUY",
    reason: "Book and executable quote qualify.",
    requestedAmount,
    executionStatus: "none",
    walletAddress: wallet,
    executable: requestedAmount
      ? {
          totalUsdg: 3.825,
          discountPercent: 23.5,
          creditOut: requestedAmount,
          requestedCredit: requestedAmount,
        }
      : undefined,
    evaluatedSpendingLimitUsdg: 25,
  };
}

function expectOk(
  result: ReturnType<typeof recordedQuoteAmount>,
  amount: number,
  label: string,
) {
  if (!result.ok || result.requestedCredit !== amount) {
    throw new Error(`${label}: expected ${amount} CREDIT, got ${JSON.stringify(result)}`);
  }
}

function expectRejected(
  result: ReturnType<typeof recordedQuoteAmount>,
  code: string,
  label: string,
) {
  if (result.ok || result.code !== code) {
    throw new Error(`${label}: expected ${code}, got ${JSON.stringify(result)}`);
  }
}

const quoteSource = readFileSync(
  new URL("../../app/api/quote/route.ts", import.meta.url),
  "utf8",
);
const validateSource = readFileSync(
  new URL("../../app/api/execute/validate/route.ts", import.meta.url),
  "utf8",
);

function inOrder(source: string, label: string, needles: string[]) {
  let last = -1;
  for (const needle of needles) {
    const at = source.indexOf(needle);
    if (at < 0) throw new Error(`${label}: missing ${needle}`);
    if (at <= last) throw new Error(`${label}: ${needle} is out of order`);
    last = at;
  }
}

// A. The persisted decision amount is the quote amount.
const fiveCredit = buyRecord(5);
expectOk(recordedQuoteAmount(fiveCredit), 5, "A");
expectOk(checkAmountAgainstMarket(5, book, 5), 5, "A");
inOrder(quoteSource, "A", [
  "recordedQuoteAmount(access.record)",
  "checkAmountAgainstMarket(",
  "quoteForCredit(requestedCredit)",
]);

// B. A client-supplied requestedCredit is not read by the quote route.
if (quoteSource.includes("body.requestedCredit") || /requestedCredit\?:/.test(quoteSource)) {
  throw new Error("B: the quote route must not read a client requestedCredit");
}
if (quoteSource.includes("requestedAmount: requestedCredit")) {
  throw new Error("B: the quote route must not rewrite the persisted decision amount");
}

// C. A 5 CREDIT decision cannot become a 20 CREDIT quote or validation.
expectOk(recordedQuoteAmount({ ...fiveCredit }), 5, "C");
expectRejected(checkAmountAgainstMarket(5, book, 20), "market_changed", "C");
inOrder(validateSource, "C", [
  "recordedQuoteAmount(current)",
  "body.quote.requestedCredit !== recorded.requestedCredit",
  "quoteForCredit(requestedCredit)",
]);

// D. The recorded amount is the floored amount, and the floor is re-checked.
const floored = decide(book, { ...DEFAULT_PARAMS, requestedCredit: 1 });
if (floored.action !== "BUY" || floored.requestedAmount !== 5) {
  throw new Error("D: decide must floor a 1 CREDIT request to the 5 CREDIT minimum");
}
expectOk(recordedQuoteAmount(buyRecord(floored.requestedAmount)), 5, "D");
expectOk(checkAmountAgainstMarket(5, book, floored.requestedAmount), 5, "D");
expectRejected(checkAmountAgainstMarket(1, book, 5), "size", "D");
const raisedMinimum = { ...book, minBuyCredit: 10 };
expectRejected(checkAmountAgainstMarket(5, raisedMinimum, 10), "size", "D");

// E. Wallet ownership is checked before any amount or quote.
if (!recordBelongsToWallet(fiveCredit, wallet) || recordBelongsToWallet(fiveCredit, otherWallet)) {
  throw new Error("E: decision ownership must be enforced");
}
inOrder(quoteSource, "E", [
  "requireOwnedDecision(body.decisionId, wallet)",
  "decisionAccessResponse(access.error)",
  "recordedQuoteAmount(access.record)",
  "quoteForCredit(requestedCredit)",
]);
inOrder(validateSource, "E", [
  "requireOwnedDecision(body.decisionId, wallet)",
  "decisionAccessResponse(access.error)",
  "recordedQuoteAmount(current)",
  "quoteForCredit(requestedCredit)",
]);

// F. A terminal decision is refused before it is quoted.
const confirmed = { ...fiveCredit, executionStatus: "success" as const };
if (canReviewDecision(confirmed)) {
  throw new Error("F: a confirmed decision must not be reviewable");
}
inOrder(quoteSource, "F", [
  "canReviewDecision(access.record)",
  'code: "terminal"',
  "quoteForCredit(requestedCredit)",
]);

// G. Missing or invalid decision data does not fall back to client input.
expectRejected(recordedQuoteAmount(buyRecord(undefined)), "missing_amount", "G");
expectRejected(recordedQuoteAmount({ ...fiveCredit, requestedAmount: 0 }), "missing_amount", "G");
expectRejected(recordedQuoteAmount({ ...fiveCredit, requestedAmount: Number.NaN }), "missing_amount", "G");
expectRejected(
  recordedQuoteAmount({
    ...fiveCredit,
    executable: { ...fiveCredit.executable!, requestedCredit: 20 },
  }),
  "missing_amount",
  "G",
);
expectRejected(
  recordedQuoteAmount({ ...fiveCredit, decision: "WAIT" }),
  "market_changed",
  "G",
);
inOrder(quoteSource, "G", [
  "if (!body.decisionId)",
  '"Missing decision."',
  "quoteForCredit(requestedCredit)",
]);
if (quoteSource.includes("settings.requestedCredit")) {
  throw new Error("G: the quote route must not fall back to the settings amount");
}

// H. The spending limit is checked against the authoritative quote total.
inOrder(quoteSource, "H", [
  "quoteForCredit(requestedCredit)",
  "quote.totalUsdg > settings.spendingLimitUsdg",
]);
inOrder(validateSource, "H", [
  "quoteForCredit(requestedCredit)",
  "fresh.totalUsdg > settings.spendingLimitUsdg",
]);

// I. The executable discount is still checked.
if (quoteMeetsMinDiscount(23.5, 24) || !quoteMeetsMinDiscount(23.5, 20)) {
  throw new Error("I: the executable discount rule changed");
}
inOrder(quoteSource, "I", [
  "quoteForCredit(requestedCredit)",
  "quoteMeetsMinDiscount(quote.discountPercent, settings.minDiscountPercent)",
]);
inOrder(validateSource, "I", [
  "quoteForCredit(requestedCredit)",
  "quoteMeetsMinDiscount(fresh.discountPercent, settings.minDiscountPercent)",
  "quotesMatch(body.quote, fresh)",
]);

// J. Validation quotes, and records, only the authoritative amount.
if (validateSource.includes("quoteForCredit(body.quote.requestedCredit)")) {
  throw new Error("J: validation must not quote the client amount");
}
if (validateSource.includes("requestedAmount: body.quote")) {
  throw new Error("J: validation must not rewrite the decision amount");
}
inOrder(validateSource, "J", [
  "decide(market, settings)",
  "checkAmountAgainstMarket(",
  "quoteForCredit(requestedCredit)",
]);

console.log("quote amount integrity ok");
