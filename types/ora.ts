export type DepthLevel = {
  discountPercent: number;
  availableCredit: number;
};

export type MarketSnapshot = {
  timestamp: string;
  creditPrice: number;
  discountPercent: number;
  bestDiscount: number;
  availableAtBestDiscount: number;
  depth: DepthLevel[];
  source: "orbio";
  totalAvailableCredit: number;
  minBuyCredit: number;
};

export type ProcurementParams = {
  minDiscountPercent: number;
  requestedCredit: number;
  spendingLimitUsdg: number;
};

export type DecisionAction = "BUY" | "WAIT";

/** Fee-inclusive terms from an exchange quote. Not an order-book level. */
export type ExecutableTerms = {
  totalUsdg: number;
  discountPercent: number;
  creditOut: number;
  requestedCredit: number;
};

export type OraReasoning = {
  recommendation: DecisionAction;
  rationale: string;
  risks: string[];
  agreesWithRule: boolean;
};

export type OraDecision = {
  action: DecisionAction;
  timestamp: string;
  market: MarketSnapshot;
  reason: string;
  requestedAmount?: number;
  params: ProcurementParams;
  /** Present when this decision was checked against an exchange quote. */
  executable?: ExecutableTerms;
};

export type ExecutionStatus =
  | "none"
  | "quoting"
  | "review"
  | "validating"
  | "awaiting_signature"
  | "pending"
  | "success"
  | "failed"
  | "blocked_limit"
  | "blocked_liquidity"
  | "blocked_funds"
  | "stale_quote";

export type ExecutableQuote = {
  quotedAt: string;
  requestedCredit: number;
  creditOut: number;
  usdgSpent: number;
  feeAtoms: number;
  totalUsdg: number;
  fills: number;
  reason: number;
  quotePrice: number;
  discountPercent: number;
  minCreditOut: number;
  usdgIn: number;
  maxFills: number;
};

export type DecisionRecord = {
  id: string;
  timestamp: string;
  market: {
    price: number;
    discountPercent: number;
    availableDepth: number;
  };
  snapshot: MarketSnapshot;
  decision: DecisionAction;
  reason: string;
  requestedAmount?: number;
  quotePrice?: number;
  quotedUsdg?: number;
  quotedAt?: string;
  /** Chain head read when the quote was validated; the purchase must be mined after it. */
  validatedBlock?: number;
  executionPrice?: number;
  txHash?: string;
  executionStatus?: ExecutionStatus;
  blockedReason?: string;
  creditAcquired?: number;
  totalUsdgPaid?: number;
  confirmedAt?: string;
  /** Owner wallet. Absent on legacy/unowned records; do not invent. */
  walletAddress?: string;
  reasoning?: OraReasoning;
  /** Quote terms used to confirm or reject BUY. Absent on older rows. */
  executable?: ExecutableTerms;
  /** Spending limit this decision was evaluated against. Absent on older rows. */
  evaluatedSpendingLimitUsdg?: number;
};

export type OutcomePhase = "decision" | "execution" | "confirmed" | "outcome";

export type DecisionOutcome = {
  decisionId: string;
  kind: "BUY" | "WAIT";
  phase: OutcomePhase;
  resolved: boolean;
  useful: boolean | null;
  summary: string;
  decisionTimestamp: string;
  decisionDiscountPercent: number;
  decisionCreditPrice: number;
  executionStatus?: ExecutionStatus;
  executionPrice?: number;
  executionDiscountPercent?: number;
  creditAcquired?: number;
  usdgPaid?: number;
  laterTimestamp?: string;
  laterDiscountPercent?: number;
  laterCreditPrice?: number;
  buyOnDemandCost?: number;
  oraCost?: number;
  costDifference?: number;
};

export type PerformanceSummary = {
  totalCreditPurchased: number;
  averageEffectivePrice: number | null;
  totalProcurementCost: number;
  comparableBuyOnDemandCost: number | null;
  difference: number | null;
  buyCount: number;
  waitCount: number;
  successfulExecutions: number;
  unresolvedCount: number;
  enoughData: boolean;
  note: string;
};

export type UserSettings = {
  spendingLimitUsdg: number;
  minDiscountPercent: number;
  requestedCredit: number;
  walletAddress?: string;
};
