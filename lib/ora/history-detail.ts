import type { DecisionAction, DecisionRecord } from "../../types/ora";
import { formatCredit, formatPrice, recordStage } from "./format";

export type DetailRow = { label: string; value: string };

export type OutcomeKind = "confirmed" | "failed" | "pending" | "none" | "wait";

export type HistoryDetailView = {
  action: DecisionAction;
  discountObserved: string;
  creditRequested?: string;
  status: string;
  reason: string;
  criteria: DetailRow[];
  /** Present only when Ora's reasoning recommended the other action. */
  disagreement?: { recommendation: DecisionAction; rationale: string };
  outcome: {
    kind: OutcomeKind;
    headline: string;
    quote: DetailRow[];
    purchase: DetailRow[];
    reason?: string;
    txHash?: string;
  };
};

const FAILED = new Set([
  "failed",
  "stale_quote",
  "blocked_limit",
  "blocked_liquidity",
  "blocked_funds",
]);

const NUM = "([\\d.,]+)";

const QUOTE_SUFFIX = new RegExp(`\\s*Executable quote is ${NUM}% at ${NUM} USDG\\.$`);

const REASON_COPY: [RegExp, (...values: string[]) => string][] = [
  [
    new RegExp(
      `^${NUM}% discount meets your ${NUM}% threshold and enough CREDIT is available to fulfill your ${NUM} CREDIT request\\.$`,
    ),
    (d, m, r) =>
      `${d}% discount meets your ${m}% minimum, and there is enough CREDIT available to fulfill your ${r} CREDIT request.`,
  ],
  [
    new RegExp(`^Best available discount is ${NUM}%, below your ${NUM}% threshold\\.$`),
    (d, m) => `${d}% discount is below your ${m}% minimum, so Ora waits.`,
  ],
  [
    new RegExp(
      `^${NUM}% discount meets your ${NUM}% threshold, but only ${NUM} CREDIT is available at that level\\. You requested ${NUM} CREDIT\\.$`,
    ),
    (d, m, a, r) =>
      `${d}% discount meets your ${m}% minimum, but only ${a} CREDIT is available at that level. You requested ${r} CREDIT.`,
  ],
];

/**
 * Display copy for a stored rule reason. Every number comes from the stored
 * sentence; text that matches no known template is shown as stored.
 */
export function reasonCopy(stored: string): string {
  const reason = stored.trim().replace(QUOTE_SUFFIX, "");
  for (const [pattern, render] of REASON_COPY) {
    const match = reason.match(pattern);
    if (match) return render(...match.slice(1));
  }
  return reason;
}

function percent(value: number): string {
  return `${value}%`;
}

function credit(value: number): string {
  return `${formatCredit(value, 6)} CREDIT`;
}

function usdg(value: number, digits = 6): string {
  return `${value.toLocaleString("en-US", { maximumFractionDigits: digits })} USDG`;
}

function present(value: number | undefined): value is number {
  return value != null && Number.isFinite(value);
}

function reviewQuoteDiscount(quotePrice: number): number {
  return Number(((1 - quotePrice) * 100).toFixed(4));
}

export function historyDetail(record: DecisionRecord): HistoryDetailView {
  const requested = record.requestedAmount ?? record.evaluatedRequestedCredit;

  const criteria: DetailRow[] = [];
  if (present(record.minDiscountPercent)) {
    criteria.push({ label: "Minimum discount", value: percent(record.minDiscountPercent) });
  }
  const limit = record.evaluatedSpendingLimitUsdg;
  const limitDecided =
    record.decision === "BUY" ||
    (record.executable != null && present(limit) && record.executable.totalUsdg > limit);
  if (present(limit) && limitDecided) {
    criteria.push({ label: "Spending limit", value: usdg(limit) });
  }

  const reasoning = record.reasoning;
  return {
    action: record.decision,
    discountObserved: percent(record.market.discountPercent),
    ...(present(requested) ? { creditRequested: credit(requested) } : {}),
    status: recordStage(record.executionStatus, record.decision),
    reason: reasonCopy(record.reason),
    criteria,
    ...(reasoning && reasoning.recommendation !== record.decision && reasoning.rationale
      ? {
          disagreement: {
            recommendation: reasoning.recommendation,
            rationale: reasoning.rationale,
          },
        }
      : {}),
    outcome: outcome(record),
  };
}

function quoteRows(record: DecisionRecord): DetailRow[] {
  if (record.decision !== "BUY") return [];
  if (present(record.quotePrice) && present(record.quotedUsdg)) {
    return [
      { label: "Executable discount", value: percent(reviewQuoteDiscount(record.quotePrice)) },
      { label: "Quoted cost", value: usdg(record.quotedUsdg, 2) },
    ];
  }
  if (record.executable) {
    return [
      { label: "Executable discount", value: percent(record.executable.discountPercent) },
      { label: "Quoted cost", value: usdg(record.executable.totalUsdg, 2) },
    ];
  }
  return [];
}

function outcome(record: DecisionRecord): HistoryDetailView["outcome"] {
  const status = record.executionStatus ?? "none";
  const txHash = record.txHash;
  const quote = quoteRows(record);

  if (record.decision === "WAIT" && !txHash) {
    return { kind: "wait", headline: "No purchase made.", quote: [], purchase: [] };
  }

  if (status === "success") {
    const purchase: DetailRow[] = [];
    if (present(record.creditAcquired)) {
      purchase.push({ label: "CREDIT acquired", value: credit(record.creditAcquired) });
    }
    if (present(record.totalUsdgPaid)) {
      purchase.push({ label: "USDG paid", value: usdg(record.totalUsdgPaid) });
    }
    if (present(record.executionPrice)) {
      purchase.push({
        label: "Execution price",
        value: `${formatPrice(record.executionPrice)} USDG per CREDIT`,
      });
    }
    return {
      kind: "confirmed",
      headline: "Purchase confirmed",
      quote,
      purchase,
      ...(txHash ? { txHash } : {}),
    };
  }

  if (txHash && FAILED.has(status)) {
    return {
      kind: "failed",
      headline: "Purchase failed",
      quote,
      purchase: [],
      txHash,
      ...(record.blockedReason ? { reason: record.blockedReason } : {}),
    };
  }

  if (txHash) {
    return { kind: "pending", headline: "Purchase pending", quote, purchase: [], txHash };
  }

  return {
    kind: "none",
    headline: "No purchase completed.",
    quote,
    purchase: [],
    ...(record.blockedReason ? { reason: record.blockedReason } : {}),
  };
}
