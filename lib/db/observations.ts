import type { BookFetchResult } from "../orbio/book-observation";
import { supabaseAdmin } from "./supabase";

export type ObservationOutcome = "incomplete" | BookFetchResult["outcome"];

export type ObservationRow = {
  slot_start: string;
  cadence_seconds: number;
  outcome: ObservationOutcome;
  attempted_at: string;
  completed_at: string | null;
  levels: { discount_bps: number; credit_atoms: number }[] | null;
  min_buy_credit_atoms: number | null;
  reported_total_credit_atoms: number | null;
  fingerprint: string | null;
  http_status: number | null;
  error_detail: string | null;
};

type CompletionPatch = Omit<ObservationRow, "slot_start" | "cadence_seconds" | "attempted_at">;

function throwIfError(error: { message: string } | null) {
  if (error) throw new Error(error.message);
}

/**
 * Inserts the slot as `incomplete`. Returns false when the slot already exists,
 * so a duplicate or overlapping invocation must not read Orbio.
 */
export async function claimObservationSlot(
  slotStart: Date,
  cadenceSeconds: number,
  attemptedAt: Date,
): Promise<boolean> {
  const { data, error } = await supabaseAdmin()
    .from("market_observations")
    .upsert(
      {
        slot_start: slotStart.toISOString(),
        cadence_seconds: cadenceSeconds,
        outcome: "incomplete",
        attempted_at: attemptedAt.toISOString(),
      },
      { onConflict: "slot_start", ignoreDuplicates: true },
    )
    .select("slot_start");
  throwIfError(error);
  return (data ?? []).length > 0;
}

export function completionPatch(
  result: BookFetchResult,
  completedAt: Date,
): CompletionPatch {
  const failed = {
    levels: null,
    min_buy_credit_atoms: null,
    reported_total_credit_atoms: null,
    fingerprint: null,
  };
  switch (result.outcome) {
    case "succeeded":
      return {
        outcome: "succeeded",
        completed_at: completedAt.toISOString(),
        levels: result.book.levels.map((level) => ({
          discount_bps: level.discountBps,
          credit_atoms: level.creditAtoms,
        })),
        min_buy_credit_atoms: result.book.minBuyCreditAtoms,
        reported_total_credit_atoms: result.book.reportedTotalCreditAtoms,
        fingerprint: result.book.fingerprint,
        http_status: null,
        error_detail: null,
      };
    case "http_error":
      return {
        ...failed,
        outcome: "http_error",
        completed_at: completedAt.toISOString(),
        http_status: result.httpStatus,
        error_detail: result.detail,
      };
    default:
      return {
        ...failed,
        outcome: result.outcome,
        completed_at: completedAt.toISOString(),
        http_status: null,
        error_detail: result.detail,
      };
  }
}

/** Finishes a claimed slot. Only an `incomplete` row is ever updated. */
export async function completeObservation(
  slotStart: Date,
  result: BookFetchResult,
  completedAt: Date,
): Promise<boolean> {
  const { data, error } = await supabaseAdmin()
    .from("market_observations")
    .update(completionPatch(result, completedAt))
    .eq("slot_start", slotStart.toISOString())
    .eq("outcome", "incomplete")
    .select("slot_start");
  throwIfError(error);
  return (data ?? []).length > 0;
}

const HISTORY_LIMIT = 24;

/** Latest successful observations. Failures and incomplete claims are not market state. */
export async function readSucceededObservations(
  limit = HISTORY_LIMIT,
): Promise<ObservationRow[]> {
  const { data, error } = await supabaseAdmin()
    .from("market_observations")
    .select(
      "slot_start, cadence_seconds, outcome, attempted_at, completed_at, levels, min_buy_credit_atoms, reported_total_credit_atoms, fingerprint, http_status, error_detail",
    )
    .eq("outcome", "succeeded")
    .order("slot_start", { ascending: false })
    .limit(limit);
  throwIfError(error);
  return ((data ?? []) as ObservationRow[]).filter(
    (row) => row.outcome === "succeeded",
  );
}

const OBSERVATION_COLUMNS =
  "slot_start, cadence_seconds, outcome, attempted_at, completed_at, levels, min_buy_credit_atoms, reported_total_credit_atoms, fingerprint, http_status, error_detail";

/** Succeeded observations after `afterExclusive` through `throughInclusive`. Failures are not market state. */
export async function readSucceededObservationsBetween(
  afterExclusive: string,
  throughInclusive: string,
): Promise<ObservationRow[]> {
  const { data, error } = await supabaseAdmin()
    .from("market_observations")
    .select(OBSERVATION_COLUMNS)
    .eq("outcome", "succeeded")
    .gt("slot_start", afterExclusive)
    .lte("slot_start", throughInclusive)
    .order("slot_start", { ascending: true })
    .limit(1000);
  throwIfError(error);
  return ((data ?? []) as ObservationRow[]).filter(
    (row) => row.outcome === "succeeded",
  );
}

/** Pages through succeeded observations covering a time span. */
export async function readSucceededObservationsCovering(
  afterExclusive: string,
  throughInclusive: string,
): Promise<ObservationRow[]> {
  const rows: ObservationRow[] = [];
  let cursor = afterExclusive;
  for (let page = 0; page < 20; page += 1) {
    const batch = await readSucceededObservationsBetween(
      cursor,
      throughInclusive,
    );
    if (batch.length === 0) break;
    const skip = rows.length > 0 && batch[0]?.slot_start === cursor ? 1 : 0;
    for (let i = skip; i < batch.length; i += 1) rows.push(batch[i]);
    if (batch.length < 1000) break;
    const next = batch[batch.length - 1]?.slot_start;
    if (!next || next === cursor) break;
    cursor = next;
  }
  return rows;
}
