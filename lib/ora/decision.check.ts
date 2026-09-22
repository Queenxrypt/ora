import type { MarketSnapshot } from "../../types/ora";
import { decide, DEFAULT_PARAMS } from "./decision";

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

console.log("decision engine ok");
console.log(waitThin.reason);
console.log(buyFillable.reason);
console.log(buy.reason);
