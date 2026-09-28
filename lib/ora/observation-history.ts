import { ATOMS } from "../orbio/contracts";
import type { ObservationRow } from "../db/observations";

export type ObservationHistoryItem = {
  slotStart: string;
  bestDiscountPercent: number | null;
  availableAtBestDiscount: number | null;
  totalAvailableCredit: number;
  minBuyCredit: number | null;
};

function creditFromAtoms(atoms: number): number {
  return atoms / ATOMS;
}

function asLevel(
  value: unknown,
): { discountBps: number; creditAtoms: number } | null {
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

/**
 * Display fields for one succeeded observation. Returns null when `levels` is
 * missing or malformed so a bad row cannot take down the history list.
 */
export function observationViewFromRow(
  row: Pick<
    ObservationRow,
    | "slot_start"
    | "levels"
    | "min_buy_credit_atoms"
    | "reported_total_credit_atoms"
  >,
): ObservationHistoryItem | null {
  if (typeof row.slot_start !== "string" || !row.slot_start.trim()) return null;
  if (!Array.isArray(row.levels)) return null;

  const levels: { discountBps: number; creditAtoms: number }[] = [];
  for (const item of row.levels) {
    const level = asLevel(item);
    if (!level) return null;
    levels.push(level);
  }

  let totalAtoms = 0;
  if (
    row.reported_total_credit_atoms != null &&
    Number.isSafeInteger(row.reported_total_credit_atoms) &&
    row.reported_total_credit_atoms >= 0
  ) {
    totalAtoms = row.reported_total_credit_atoms;
  } else {
    for (const level of levels) totalAtoms += level.creditAtoms;
  }

  const best = levels[0];
  const minAtoms = row.min_buy_credit_atoms;
  return {
    slotStart: row.slot_start,
    bestDiscountPercent: best ? best.discountBps / 100 : null,
    availableAtBestDiscount: best ? creditFromAtoms(best.creditAtoms) : null,
    totalAvailableCredit: creditFromAtoms(totalAtoms),
    minBuyCredit:
      minAtoms != null && Number.isSafeInteger(minAtoms) && minAtoms > 0
        ? creditFromAtoms(minAtoms)
        : null,
  };
}

export function observationHistoryItems(
  rows: Pick<
    ObservationRow,
    | "slot_start"
    | "levels"
    | "min_buy_credit_atoms"
    | "reported_total_credit_atoms"
  >[],
): ObservationHistoryItem[] {
  const items: ObservationHistoryItem[] = [];
  for (const row of rows) {
    const item = observationViewFromRow(row);
    if (item) items.push(item);
  }
  return items;
}
