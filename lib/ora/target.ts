import type {
  DecisionAction,
  DecisionRecord,
  ExecutableTerms,
  MarketSnapshot,
  OraDecision,
  ProcurementParams,
  ProcurementTarget,
  TargetStatus,
} from "../../types/ora";
import { ATOMS } from "../orbio/contracts";
import { decide, decideWithExecutableQuote } from "./decision";

export const OPEN_TARGET_STATUSES: TargetStatus[] = ["WATCHING", "READY"];

export const TARGET_STATUS_COPY: Record<
  Exclude<TargetStatus, "CANCELLED">,
  { label: string; detail: string }
> = {
  WATCHING: {
    label: "ORA IS WATCHING",
    detail: "Ora is watching the CREDIT market for a qualifying opportunity.",
  },
  READY: {
    label: "READY TO BUY",
    detail: "Ora found a qualifying opportunity.",
  },
  FULFILLED: {
    label: "TARGET COMPLETE",
    detail: "Purchase confirmed.",
  },
};

export type TargetParams = {
  requestedCredit: number;
  minDiscountPercent: number;
  maxSpendUsdg: number;
};

export type TargetQuoteFn = (
  requestedCredit: number,
) => Promise<ExecutableTerms | null>;

export type TargetEvaluation = {
  status: "WATCHING" | "READY";
  decision: OraDecision;
  quoted: boolean;
};

export type ObservedTargetBook = {
  levels: { discountBps: number; creditAtoms: number }[];
  minBuyCreditAtoms: number | null;
  reportedTotalCreditAtoms: number | null;
};

export type TargetFieldValidation =
  | { ok: true; params: TargetParams }
  | { ok: false; error: string };

const MAX_CREDIT = 1_000_000_000;
const MAX_SPEND = 1_000_000_000;

export function isOpenTargetStatus(status: TargetStatus): boolean {
  return status === "WATCHING" || status === "READY";
}

export function targetProcurementParams(params: TargetParams): ProcurementParams {
  return {
    requestedCredit: params.requestedCredit,
    minDiscountPercent: params.minDiscountPercent,
    spendingLimitUsdg: params.maxSpendUsdg,
  };
}

export function paramsFromTarget(target: Pick<
  ProcurementTarget,
  "requestedCredit" | "minDiscountPercent" | "maxSpendUsdg"
>): TargetParams {
  return {
    requestedCredit: target.requestedCredit,
    minDiscountPercent: target.minDiscountPercent,
    maxSpendUsdg: target.maxSpendUsdg,
  };
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function validateTargetFields(input: {
  requestedCredit?: unknown;
  minDiscountPercent?: unknown;
  maxSpendUsdg?: unknown;
  spendingLimitUsdg?: unknown;
}): TargetFieldValidation {
  const requestedCredit = finiteNumber(input.requestedCredit);
  const minDiscountPercent = finiteNumber(input.minDiscountPercent);
  const maxSpendUsdg = finiteNumber(
    input.maxSpendUsdg ?? input.spendingLimitUsdg,
  );
  if (requestedCredit == null || requestedCredit <= 0 || requestedCredit > MAX_CREDIT) {
    return { ok: false, error: "Requested CREDIT must be a positive amount." };
  }
  if (
    minDiscountPercent == null ||
    minDiscountPercent < 0 ||
    minDiscountPercent > 100
  ) {
    return { ok: false, error: "Minimum discount must be between 0% and 100%." };
  }
  if (maxSpendUsdg == null || maxSpendUsdg <= 0 || maxSpendUsdg > MAX_SPEND) {
    return { ok: false, error: "Maximum spend must be a positive USDG amount." };
  }
  return {
    ok: true,
    params: { requestedCredit, minDiscountPercent, maxSpendUsdg },
  };
}

/**
 * Book snapshot for the cheap target screen. Uses the observation (or live)
 * depth only. Never treats listed prices as executable terms.
 */
export function marketSnapshotFromObservedBook(
  book: ObservedTargetBook,
  timestamp = new Date().toISOString(),
): MarketSnapshot {
  const depth = book.levels.map((level) => ({
    discountPercent: level.discountBps / 100,
    availableCredit: level.creditAtoms / ATOMS,
  }));
  const best = depth[0] ?? { discountPercent: 0, availableCredit: 0 };
  let totalAtoms = 0;
  if (
    book.reportedTotalCreditAtoms != null &&
    Number.isSafeInteger(book.reportedTotalCreditAtoms) &&
    book.reportedTotalCreditAtoms >= 0
  ) {
    totalAtoms = book.reportedTotalCreditAtoms;
  } else {
    for (const level of book.levels) totalAtoms += level.creditAtoms;
  }
  const minAtoms = book.minBuyCreditAtoms;
  return {
    timestamp,
    creditPrice: Number((1 - best.discountPercent / 100).toFixed(6)),
    discountPercent: best.discountPercent,
    bestDiscount: best.discountPercent,
    availableAtBestDiscount: best.availableCredit,
    depth,
    source: "orbio",
    totalAvailableCredit: totalAtoms / ATOMS,
    minBuyCredit:
      minAtoms != null && Number.isSafeInteger(minAtoms) && minAtoms > 0
        ? minAtoms / ATOMS
        : 5,
  };
}

export function executableTermsFromQuote(terms: {
  totalUsdg: number;
  discountPercent: number;
  creditOut: number;
  requestedCredit: number;
}): ExecutableTerms {
  return {
    totalUsdg: terms.totalUsdg,
    discountPercent: terms.discountPercent,
    creditOut: terms.creditOut,
    requestedCredit: terms.requestedCredit,
  };
}

/**
 * Shared target evaluator. Book screening always runs first via `decide`.
 * READY requires a passing executable quote for the same requested amount.
 * Omitting `quote` never produces READY.
 */
export async function evaluateTarget(
  market: MarketSnapshot,
  params: TargetParams,
  quote?: TargetQuoteFn,
): Promise<TargetEvaluation> {
  const procurement = targetProcurementParams(params);
  const book = decide(market, procurement);
  if (book.action !== "BUY" || book.requestedAmount == null) {
    return { status: "WATCHING", decision: book, quoted: false };
  }
  if (!quote) {
    return { status: "WATCHING", decision: book, quoted: false };
  }
  let terms: ExecutableTerms | null;
  try {
    terms = await quote(book.requestedAmount);
  } catch {
    terms = null;
  }
  const result = decideWithExecutableQuote(market, procurement, terms);
  if (result.action === "BUY" && result.executable) {
    return { status: "READY", decision: result, quoted: true };
  }
  return { status: "WATCHING", decision: result, quoted: true };
}

export function evaluationWrite(
  evaluation: TargetEvaluation,
  now = new Date(),
): {
  status: "WATCHING" | "READY";
  lastEvaluatedAt: string;
  lastEvaluationAction: DecisionAction;
  lastEvaluationReason: string;
  lastRequestedAmount: number | null;
  lastExecutableDiscountPercent: number | null;
  lastExecutableTotalUsdg: number | null;
  updatedAt: string;
} {
  const ready = evaluation.status === "READY";
  const iso = now.toISOString();
  return {
    status: evaluation.status,
    lastEvaluatedAt: iso,
    lastEvaluationAction: evaluation.decision.action,
    lastEvaluationReason: evaluation.decision.reason,
    lastRequestedAmount: evaluation.decision.requestedAmount ?? null,
    lastExecutableDiscountPercent: ready
      ? (evaluation.decision.executable?.discountPercent ?? null)
      : null,
    lastExecutableTotalUsdg: ready
      ? (evaluation.decision.executable?.totalUsdg ?? null)
      : null,
    updatedAt: iso,
  };
}

/**
 * Frozen procurement params for a target-linked decision.
 * Returns null when the row is not target-linked or the freeze is incomplete.
 */
export function paramsForTargetLinkedDecision(
  record: DecisionRecord,
): ProcurementParams | null {
  if (!record.targetId) return null;
  const minDiscountPercent = record.minDiscountPercent;
  const spendingLimitUsdg = record.evaluatedSpendingLimitUsdg;
  const requestedCredit =
    record.evaluatedRequestedCredit ?? record.requestedAmount;
  if (
    minDiscountPercent == null ||
    spendingLimitUsdg == null ||
    requestedCredit == null ||
    !Number.isFinite(minDiscountPercent) ||
    !Number.isFinite(spendingLimitUsdg) ||
    !Number.isFinite(requestedCredit)
  ) {
    return null;
  }
  return {
    requestedCredit,
    minDiscountPercent,
    spendingLimitUsdg,
  };
}
