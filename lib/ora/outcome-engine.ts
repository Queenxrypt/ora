import type { DecisionRecord } from "../../types/ora";
import type { ObservationRow } from "../db/observations";
import { ATOMS } from "../orbio/contracts";
import { isConfirmedBuy } from "./outcomes";
import { discountFromPrice } from "./baseline";

/** Current default. Pass a different `windowMs` to evaluate without a redesign. */
export const DEFAULT_OUTCOME_EVALUATION_WINDOW_MS = 12 * 60 * 60 * 1000;

export type OutcomeLifecycle = "pending" | "final";

export type ObservedOpportunity = {
  observedAt: string;
  observedDiscountPercent: number;
  elapsedMs: number;
};

export type MarketOutcome = {
  decisionId: string;
  action: "BUY" | "WAIT";
  lifecycle: OutcomeLifecycle;
  applicable: boolean;
  evaluationWindowMs: number;
  windowStart: string;
  windowEnd: string;
  decisionTimestamp: string;
  originalObservedDiscountPercent: number;
  minDiscountPercent: number | null;
  requestedCredit: number | null;
  purchaseDiscountPercent: number | null;
  firstQualifyingOpportunity: ObservedOpportunity | null;
  betterObservedOpportunity: ObservedOpportunity | null;
};

export type AfterMarketView = {
  headline: string;
  note?: string;
  rows: { label: string; value: string }[];
};

type ObservedLevel = {
  discountBps: number;
  creditAtoms: number;
};

export function evaluationWindowEnd(
  originIso: string,
  windowMs = DEFAULT_OUTCOME_EVALUATION_WINDOW_MS,
): string {
  return new Date(Date.parse(originIso) + windowMs).toISOString();
}

export function observationInWindow(
  slotStart: string,
  originMs: number,
  windowEndMs: number,
): boolean {
  const slotMs = Date.parse(slotStart);
  if (!Number.isFinite(slotMs)) return false;
  return slotMs > originMs && slotMs <= windowEndMs;
}

export function formatElapsedDuration(elapsedMs: number): string {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return "0 minutes";
  const totalMinutes = Math.floor(elapsedMs / 60_000);
  if (totalMinutes < 1) return "less than 1 minute";
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  const hourPart = hours === 1 ? "1 hour" : `${hours} hours`;
  if (minutes === 0) return hourPart;
  const minutePart = minutes === 1 ? "1 minute" : `${minutes} minutes`;
  return `${hourPart} ${minutePart}`;
}

function asLevel(value: unknown): ObservedLevel | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const row = value as Record<string, unknown>;
  const discountBps = row.discount_bps;
  const creditAtoms = row.credit_atoms;
  if (
    typeof discountBps !== "number" ||
    !Number.isInteger(discountBps) ||
    discountBps < 0 ||
    discountBps > 10_000
  ) {
    return null;
  }
  if (
    typeof creditAtoms !== "number" ||
    !Number.isSafeInteger(creditAtoms) ||
    creditAtoms < 0
  ) {
    return null;
  }
  return { discountBps, creditAtoms };
}

function parseLevels(row: Pick<ObservationRow, "levels">): ObservedLevel[] | null {
  if (!Array.isArray(row.levels)) return null;
  const levels: ObservedLevel[] = [];
  for (const item of row.levels) {
    const level = asLevel(item);
    if (!level) return null;
    levels.push(level);
  }
  return levels;
}

function creditToAtoms(credit: number): number | null {
  if (!Number.isFinite(credit) || credit <= 0) return null;
  const atoms = Math.round(credit * ATOMS);
  return Number.isSafeInteger(atoms) && atoms > 0 ? atoms : null;
}

function waitRequestedCredit(record: DecisionRecord): number | null {
  const value = record.evaluatedRequestedCredit ?? record.requestedAmount;
  return value != null && Number.isFinite(value) && value > 0 ? value : null;
}

function buyComparedCredit(record: DecisionRecord): number | null {
  const value =
    record.creditAcquired ??
    record.requestedAmount ??
    record.evaluatedRequestedCredit;
  return value != null && Number.isFinite(value) && value > 0 ? value : null;
}

function purchaseDiscountPercent(record: DecisionRecord): number | null {
  if (record.executionPrice != null && Number.isFinite(record.executionPrice)) {
    return discountFromPrice(record.executionPrice);
  }
  if (record.executable && Number.isFinite(record.executable.discountPercent)) {
    return record.executable.discountPercent;
  }
  if (record.quotePrice != null && Number.isFinite(record.quotePrice)) {
    return discountFromPrice(record.quotePrice);
  }
  return null;
}

function opportunityFrom(
  originMs: number,
  slotStart: string,
  discountPercent: number,
): ObservedOpportunity {
  return {
    observedAt: slotStart,
    observedDiscountPercent: discountPercent,
    elapsedMs: Date.parse(slotStart) - originMs,
  };
}

function bestWaitDiscount(
  levels: ObservedLevel[],
  minDiscountPercent: number,
  requestedAtoms: number,
): number | null {
  let best: number | null = null;
  for (const level of levels) {
    const discountPercent = level.discountBps / 100;
    if (discountPercent < minDiscountPercent) continue;
    if (level.creditAtoms < requestedAtoms) continue;
    if (best == null || discountPercent > best) best = discountPercent;
  }
  return best;
}

function bestBetterBuyDiscount(
  levels: ObservedLevel[],
  purchaseDiscount: number,
  requestedAtoms: number,
): number | null {
  let best: number | null = null;
  for (const level of levels) {
    const discountPercent = level.discountBps / 100;
    if (discountPercent <= purchaseDiscount) continue;
    if (level.creditAtoms < requestedAtoms) continue;
    if (best == null || discountPercent > best) best = discountPercent;
  }
  return best;
}

function inWindowSucceeded(
  rows: ObservationRow[],
  originMs: number,
  windowEndMs: number,
): { slotStart: string; levels: ObservedLevel[] }[] {
  const items: { slotStart: string; levels: ObservedLevel[] }[] = [];
  for (const row of rows) {
    if (row.outcome !== "succeeded") continue;
    if (!observationInWindow(row.slot_start, originMs, windowEndMs)) continue;
    const levels = parseLevels(row);
    if (!levels) continue;
    items.push({ slotStart: row.slot_start, levels });
  }
  items.sort((a, b) => Date.parse(a.slotStart) - Date.parse(b.slotStart));
  return items;
}

function baseOutcome(
  record: DecisionRecord,
  windowMs: number,
  lifecycle: OutcomeLifecycle,
  applicable: boolean,
): MarketOutcome {
  const windowStart = record.timestamp;
  return {
    decisionId: record.id,
    action: record.decision,
    lifecycle,
    applicable,
    evaluationWindowMs: windowMs,
    windowStart,
    windowEnd: evaluationWindowEnd(windowStart, windowMs),
    decisionTimestamp: record.timestamp,
    originalObservedDiscountPercent: record.market.discountPercent,
    minDiscountPercent: record.minDiscountPercent ?? null,
    requestedCredit: waitRequestedCredit(record),
    purchaseDiscountPercent: null,
    firstQualifyingOpportunity: null,
    betterObservedOpportunity: null,
  };
}

export function evaluateMarketOutcome(
  record: DecisionRecord,
  observations: ObservationRow[],
  nowMs = Date.now(),
  windowMs = DEFAULT_OUTCOME_EVALUATION_WINDOW_MS,
): MarketOutcome {
  const originMs = Date.parse(record.timestamp);
  const windowEndMs = originMs + windowMs;
  const lifecycle: OutcomeLifecycle = nowMs < windowEndMs ? "pending" : "final";
  const windowed = inWindowSucceeded(observations, originMs, windowEndMs);

  if (record.decision === "WAIT") {
    const minDiscount = record.minDiscountPercent;
    const requested = waitRequestedCredit(record);
    const requestedAtoms = requested != null ? creditToAtoms(requested) : null;
    const outcome = baseOutcome(record, windowMs, lifecycle, true);
    if (
      minDiscount == null ||
      !Number.isFinite(minDiscount) ||
      requestedAtoms == null
    ) {
      return outcome;
    }
    for (const item of windowed) {
      const discount = bestWaitDiscount(
        item.levels,
        minDiscount,
        requestedAtoms,
      );
      if (discount != null) {
        outcome.firstQualifyingOpportunity = opportunityFrom(
          originMs,
          item.slotStart,
          discount,
        );
        break;
      }
    }
    return outcome;
  }

  if (!isConfirmedBuy(record)) {
    return baseOutcome(record, windowMs, lifecycle, false);
  }

  const comparedCredit = buyComparedCredit(record);
  const requestedAtoms =
    comparedCredit != null ? creditToAtoms(comparedCredit) : null;
  const purchaseDiscount = purchaseDiscountPercent(record);
  const outcome = baseOutcome(record, windowMs, lifecycle, true);
  outcome.requestedCredit = comparedCredit;
  outcome.purchaseDiscountPercent = purchaseDiscount;
  if (purchaseDiscount == null || requestedAtoms == null) return outcome;

  let best: ObservedOpportunity | null = null;
  for (const item of windowed) {
    const discount = bestBetterBuyDiscount(
      item.levels,
      purchaseDiscount,
      requestedAtoms,
    );
    if (discount == null) continue;
    if (best == null || discount > best.observedDiscountPercent) {
      best = opportunityFrom(originMs, item.slotStart, discount);
    }
  }
  outcome.betterObservedOpportunity = best;
  return outcome;
}

function windowPhrase(windowMs: number): string {
  const hours = windowMs / 3_600_000;
  if (Number.isInteger(hours) && hours > 0) {
    return hours === 1 ? "1-hour" : `${hours}-hour`;
  }
  return "evaluation";
}

export function afterMarketView(outcome: MarketOutcome): AfterMarketView | null {
  if (!outcome.applicable) return null;
  const windowLabel = windowPhrase(outcome.evaluationWindowMs);
  if (outcome.lifecycle === "pending") {
    return {
      headline: `The ${windowLabel} evaluation window is still open.`,
      rows: [],
    };
  }

  if (outcome.action === "WAIT") {
    if (outcome.minDiscountPercent == null || outcome.requestedCredit == null) {
      return {
        headline: "Decision criteria were not stored",
        note: "A qualifying opportunity cannot be determined from this record.",
        rows: [],
      };
    }
    const found = outcome.firstQualifyingOpportunity;
    if (!found) {
      return {
        headline: "No qualifying opportunity observed",
        note: `within the ${windowLabel} evaluation window.`,
        rows: [],
      };
    }
    return {
      headline: "Later qualifying opportunity",
      rows: [
        { label: "Observed discount", value: `${found.observedDiscountPercent}%` },
        { label: "Appeared after", value: formatElapsedDuration(found.elapsedMs) },
      ],
    };
  }

  const found = outcome.betterObservedOpportunity;
  if (!found) {
    return {
      headline: "No better observed opportunity",
      note: `within the ${windowLabel} evaluation window.`,
      rows: [],
    };
  }
  return {
    headline: "Later observed opportunity",
    rows: [
      { label: "Observed discount", value: `${found.observedDiscountPercent}%` },
      { label: "Appeared after", value: formatElapsedDuration(found.elapsedMs) },
    ],
  };
}
