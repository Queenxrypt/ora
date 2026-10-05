import type { ProcurementTarget } from "../../../types/ora";
import type { AlertChannel, TargetAlertStatus } from "../../db/alerts";
import { formatCredit } from "../format";

export const READY_ALERT_CHANNEL: AlertChannel = "telegram";

/** Minimum time between alerts for the same target across READY periods. */
export const READY_ALERT_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * Alerts that were, or may still be, delivered. Suppressed, skipped and
 * permanently failed alerts never reached the user and do not start a cooldown.
 */
export const COOLDOWN_ALERT_STATUSES: readonly TargetAlertStatus[] = [
  "pending",
  "sending",
  "sent",
  "unknown",
  "failed_retryable",
];

/** Informational only. Carries no wallet, target, decision or transaction identifiers. */
export type ReadyAlertPayload = {
  requestedCredit: number;
  executableDiscountPercent: number;
  quotedCostUsdg: number;
  quotedAt: string;
  readySince: string;
  text: string;
};

export function cooldownReference(alert: {
  sent_at: string | null;
  created_at: string;
}): string {
  return alert.sent_at ?? alert.created_at;
}

/**
 * A new READY period alerts unless the previous alert for the target is less
 * than the cooldown before the period started.
 */
export function alertStatusForPeriod(
  readySince: string,
  previousAlertAt: string | null,
): "pending" | "suppressed" {
  if (previousAlertAt == null) return "pending";
  const elapsed = Date.parse(readySince) - Date.parse(previousAlertAt);
  if (!Number.isFinite(elapsed)) return "suppressed";
  return elapsed < READY_ALERT_COOLDOWN_MS ? "suppressed" : "pending";
}

function formatPercent(value: number): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

function formatUsdg(value: number): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatUtcTime(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  return `${hours}:${minutes} UTC`;
}

export function readyAlertText(facts: {
  requestedCredit: number;
  executableDiscountPercent: number;
  quotedCostUsdg: number;
  quotedAt: string;
}): string | null {
  const quotedTime = formatUtcTime(facts.quotedAt);
  if (!quotedTime) return null;
  return [
    "Ora — procurement target READY",
    "",
    `Requested: ${formatCredit(facts.requestedCredit)} CREDIT`,
    `Executable discount: ${formatPercent(facts.executableDiscountPercent)}%`,
    `Quoted cost: ${formatUsdg(facts.quotedCostUsdg)} USDG (quoted ${quotedTime})`,
    "",
    "Nothing has been purchased. Prices can change.",
    "",
    "Open Ora to re-check the market and review. Ora never buys without your wallet signature.",
  ].join("\n");
}

/**
 * Builds the alert from the executable facts the watcher persisted with READY.
 * Returns null when the target is not READY or the facts are incomplete.
 */
export function prepareReadyAlert(
  target: Pick<
    ProcurementTarget,
    | "status"
    | "requestedCredit"
    | "readySince"
    | "lastEvaluatedAt"
    | "lastRequestedAmount"
    | "lastExecutableDiscountPercent"
    | "lastExecutableTotalUsdg"
  >,
): ReadyAlertPayload | null {
  if (target.status !== "READY" || !target.readySince) return null;
  const requestedCredit = target.lastRequestedAmount ?? target.requestedCredit;
  const executableDiscountPercent = target.lastExecutableDiscountPercent;
  const quotedCostUsdg = target.lastExecutableTotalUsdg;
  const quotedAt = target.lastEvaluatedAt;
  if (
    executableDiscountPercent == null ||
    quotedCostUsdg == null ||
    !quotedAt ||
    !Number.isFinite(requestedCredit) ||
    !Number.isFinite(executableDiscountPercent) ||
    !Number.isFinite(quotedCostUsdg)
  ) {
    return null;
  }
  const facts = {
    requestedCredit,
    executableDiscountPercent,
    quotedCostUsdg,
    quotedAt,
  };
  const text = readyAlertText(facts);
  if (!text) return null;
  return { ...facts, readySince: target.readySince, text };
}

/** Stage 1 sender: logs the prepared alert. Nothing is sent to Telegram. */
export function logReadyAlert(alertId: string, payload: ReadyAlertPayload): ReadyAlertPayload {
  console.info(
    `Ready alert ${alertId} prepared for ${READY_ALERT_CHANNEL}; sending is not enabled.\n${payload.text}`,
  );
  return payload;
}
