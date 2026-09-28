import { createHash } from "node:crypto";
import { ORBIO_MARKET_ORIGIN } from "./contracts";

export const DEFAULT_OBSERVATION_CADENCE_SECONDS = 300;
export const OBSERVATION_FETCH_TIMEOUT_MS = 10_000;
const MAX_DETAIL = 300;

/** Exact CREDIT atoms (6 decimals) listed at one discount level. */
export type ObservedLevel = {
  discountBps: number;
  creditAtoms: number;
};

export type ObservedBook = {
  /** Non-zero levels, highest discount first. May be empty. */
  levels: ObservedLevel[];
  /** Null when Orbio did not report a valid minimum. Never defaulted. */
  minBuyCreditAtoms: number | null;
  /** Orbio's reported total, kept as reported. Not checked against levels. */
  reportedTotalCreditAtoms: number | null;
  fingerprint: string;
};

export type BookValidation =
  | { ok: true; book: ObservedBook }
  | { ok: false; detail: string };

export type BookFetchResult =
  | { outcome: "succeeded"; book: ObservedBook }
  | { outcome: "timeout" | "network" | "invalid_payload"; detail: string }
  | { outcome: "http_error"; httpStatus: number; detail: string };

/** Bounds so a typo cannot create an unusable polling interval. */
export const MIN_OBSERVATION_CADENCE_SECONDS = 60;
export const MAX_OBSERVATION_CADENCE_SECONDS = 86_400;

export function observationCadenceSeconds(
  raw: string | undefined = process.env.OBSERVATION_CADENCE_SECONDS,
): number {
  const value = raw?.trim();
  if (!value) return DEFAULT_OBSERVATION_CADENCE_SECONDS;
  const seconds = /^\d+$/.test(value) ? Number(value) : NaN;
  if (
    !Number.isSafeInteger(seconds) ||
    seconds < MIN_OBSERVATION_CADENCE_SECONDS ||
    seconds > MAX_OBSERVATION_CADENCE_SECONDS
  ) {
    throw new Error(`OBSERVATION_CADENCE_SECONDS is invalid: ${value}`);
  }
  return seconds;
}

/** The currently open slot: `now` floored to the cadence boundary from the Unix epoch. */
export function observationSlot(now: Date, cadenceSeconds: number): Date {
  const size = cadenceSeconds * 1000;
  return new Date(Math.floor(now.getTime() / size) * size);
}

function atoms(value: unknown): number | null {
  if (typeof value === "string") {
    if (!/^\d+$/.test(value)) return null;
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : null;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

export function bookFingerprint(
  levels: ObservedLevel[],
  minBuyCreditAtoms: number | null,
): string {
  const canonical = JSON.stringify({
    levels: levels.map((level) => [level.discountBps, level.creditAtoms]),
    minBuyCreditAtoms,
  });
  return `v1:${createHash("sha256").update(canonical).digest("hex")}`;
}

/**
 * Validates only the fields Ora relies on. `rows` must be present and every row
 * exact; `minBuyMicroUsd` and `totalMicroUsd` are recorded when valid and null
 * otherwise. Other fields are ignored.
 */
export function validateBook(raw: unknown): BookValidation {
  if (!isObject(raw)) return { ok: false, detail: "Response is not a JSON object." };
  if (!Array.isArray(raw.rows)) return { ok: false, detail: "rows is not an array." };

  const seen = new Set<number>();
  const levels: ObservedLevel[] = [];
  for (const [index, row] of raw.rows.entries()) {
    if (!isObject(row)) return { ok: false, detail: `rows[${index}] is not an object.` };
    const discountBps = row.discountBps;
    if (
      typeof discountBps !== "number" ||
      !Number.isInteger(discountBps) ||
      discountBps < 0 ||
      discountBps > 10_000
    ) {
      return { ok: false, detail: `rows[${index}].discountBps is not an integer from 0 to 10000.` };
    }
    if (seen.has(discountBps)) {
      return { ok: false, detail: `rows[${index}].discountBps ${discountBps} is duplicated.` };
    }
    seen.add(discountBps);
    const creditAtoms = atoms(row.microUsd);
    if (creditAtoms == null) {
      return { ok: false, detail: `rows[${index}].microUsd is not an exact non-negative integer.` };
    }
    if (creditAtoms > 0) levels.push({ discountBps, creditAtoms });
  }
  levels.sort((a, b) => b.discountBps - a.discountBps);

  const minBuy = atoms(raw.minBuyMicroUsd);
  const minBuyCreditAtoms = minBuy != null && minBuy > 0 ? minBuy : null;
  const reportedTotalCreditAtoms = atoms(raw.totalMicroUsd);

  return {
    ok: true,
    book: {
      levels,
      minBuyCreditAtoms,
      reportedTotalCreditAtoms,
      fingerprint: bookFingerprint(levels, minBuyCreditAtoms),
    },
  };
}

function errorName(error: unknown): string | undefined {
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === "string" ? name : undefined;
}

function errorDetail(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  const text = typeof message === "string" ? `${errorName(error) ?? "Error"}: ${message}` : String(error);
  return text.slice(0, MAX_DETAIL);
}

function isTimeout(error: unknown): boolean {
  const name = errorName(error);
  return name === "TimeoutError" || name === "AbortError";
}

/** One read of the Orbio book. Never throws and never retries. */
export async function fetchObservedBook(
  timeoutMs = OBSERVATION_FETCH_TIMEOUT_MS,
): Promise<BookFetchResult> {
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  let text: string;
  try {
    response = await fetch(`${ORBIO_MARKET_ORIGIN}/api/market/book`, {
      cache: "no-store",
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return {
        outcome: "http_error",
        httpStatus: response.status,
        detail: `Orbio market book returned HTTP ${response.status}.`,
      };
    }
    text = await response.text();
  } catch (error) {
    return {
      outcome: isTimeout(error) ? "timeout" : "network",
      detail: errorDetail(error),
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { outcome: "invalid_payload", detail: "Response body is not JSON." };
  }
  const validated = validateBook(raw);
  if (!validated.ok) return { outcome: "invalid_payload", detail: validated.detail };
  return { outcome: "succeeded", book: validated.book };
}
