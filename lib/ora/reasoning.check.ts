import type { MarketSnapshot, OraDecision } from "../../types/ora";
import { decide, DEFAULT_PARAMS } from "./decision";
import { finalDecisionAction, parseReasoningOutput } from "./reasoning";

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

const decision = decide(deep, DEFAULT_PARAMS);
if (decision.action !== "BUY") {
  throw new Error("Fixture must be BUY");
}

const parsed = parseReasoningOutput(
  {
    recommendation: "WAIT",
    rationale:
      "Liquidity is currently sufficient for the requested amount, but the available depth is concentrated around the current level.",
    risks: ["Thin book below the best level", "Fill may differ from the listed discount"],
    agreesWithRule: true,
  },
  decision.action,
);
if (!parsed) {
  throw new Error("Expected structured reasoning to parse");
}
if (parsed.recommendation !== "WAIT") {
  throw new Error("Parsed recommendation should stay WAIT");
}
if (parsed.agreesWithRule !== false) {
  throw new Error("agreesWithRule must be derived from the deterministic action");
}

const fromText = parseReasoningOutput(
  '```json\n{"recommendation":"BUY","rationale":"Discount meets the threshold with enough CREDIT at that level.","risks":["Quote may differ from the book"]}\n```',
  "BUY",
);
if (!fromText || fromText.recommendation !== "BUY" || fromText.agreesWithRule !== true) {
  throw new Error("Expected JSON fence parsing to succeed");
}

if (parseReasoningOutput("not json", "BUY") != null) {
  throw new Error("Invalid output must be unavailable");
}
if (parseReasoningOutput({ recommendation: "HOLD", rationale: "x", risks: [] }, "BUY") != null) {
  throw new Error("Unknown recommendation must be unavailable");
}

if (finalDecisionAction(decision, parsed) !== "BUY") {
  throw new Error("Model WAIT must not change the deterministic BUY");
}
if (finalDecisionAction(decision, fromText) !== decision.action) {
  throw new Error("Agreeing BUY must still leave the engine in control");
}

const afterReasoning: OraDecision = { ...decision };
if (afterReasoning.action !== "BUY" || afterReasoning.requestedAmount !== 5) {
  throw new Error("Decision object must remain BUY with requested size 5");
}

delete process.env.ORBIO_API_KEY;
const { reasonAboutDecision } = await import("../orbio/reason.ts");
const unavailable = await reasonAboutDecision(decision);
if (unavailable !== null) {
  throw new Error("Missing ORBIO_API_KEY must return unavailable reasoning");
}
if (decision.action !== "BUY") {
  throw new Error("Missing key must not change BUY");
}
if (finalDecisionAction(decision, null) !== "BUY") {
  throw new Error("Unavailable reasoning must not change BUY");
}

console.log("reasoning layer ok");
