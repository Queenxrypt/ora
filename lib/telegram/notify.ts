import type { ProcurementTarget } from "../../types/ora";
import type { TargetAlertRow } from "../db/alerts";
import {
  claimTelegramAlert,
  disableUnreachableTelegramLink,
  expireInterruptedTelegramClaims,
  finishTelegramAlert,
  listDueTelegramAlerts,
  MAX_ALERT_ATTEMPTS,
  skipTelegramAlert,
} from "../db/alert-delivery";
import { readActiveLinkForWallet } from "../db/telegram";
import { requireOwnedTarget } from "../db/targets";
import { prepareReadyAlert } from "../ora/alerts/ready-alert";
import { oraAppUrl } from "./config";
import { telegramAlertsEnabled, telegramBotToken } from "./delivery-config";
import { sendTelegramMessage, TELEGRAM_SEND_TIMEOUT_MS, type TelegramSendResult } from "./send";

/** Upper bound on sends per observation. */
export const MAX_SENDS_PER_RUN = 10;
/** Time a send needs: the request timeout plus bookkeeping. */
const MIN_REMAINING_MS = TELEGRAM_SEND_TIMEOUT_MS + 1_000;
/** A `sending` claim older than this was interrupted. */
const INTERRUPTED_CLAIM_MS = 5 * 60 * 1000;
/** Delay before retry n (1-based) after a retryable failure. */
const RETRY_BACKOFF_MS = [60_000, 5 * 60_000];
const MAX_RETRY_DELAY_MS = 60 * 60_000;

export const OPEN_ORA_BUTTON_TEXT = "Open Ora";

export type NotificationOutcome =
  | "sent"
  | "skipped"
  | "claimed_elsewhere"
  | "failed_retryable"
  | "failed_permanent"
  | "unknown"
  | "error";

export type NotificationRun =
  | { status: "disabled" | "misconfigured" }
  | {
      status: "ran";
      results: { alertId: string; outcome: NotificationOutcome; reason?: string }[];
      stoppedEarly: boolean;
    };

/** Fixed destination: no wallet, target, alert, decision or token in the URL. */
export function openOraUrl(): string {
  return `${oraAppUrl()}/app#targets`;
}

function microsecondKey(value: string): string | null {
  const match =
    /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)$/.exec(
      value.trim(),
    );
  if (!match) return null;
  const [, date, time, fraction = "", zone] = match;
  const seconds = Date.parse(`${date}T${time}${zone === "Z" ? "Z" : zone.length === 3 ? `${zone}:00` : zone}`);
  if (!Number.isFinite(seconds)) return null;
  return `${seconds}.${fraction.padEnd(6, "0")}`;
}

/** Same instant to the microsecond; Postgres keeps microseconds that Date drops. */
export function sameReadyPeriod(alertReadySince: string, targetReadySince: string | undefined): boolean {
  if (!targetReadySince) return false;
  if (alertReadySince === targetReadySince) return true;
  const a = microsecondKey(alertReadySince);
  const b = microsecondKey(targetReadySince);
  return a != null && a === b;
}

type Eligibility =
  | { ok: true; target: ProcurementTarget; chatId: number; text: string }
  | { ok: false; reason: string };

async function checkEligibility(alert: TargetAlertRow): Promise<Eligibility> {
  if (alert.channel !== "telegram") return { ok: false, reason: "unsupported_channel" };
  if (alert.status === "failed_retryable" && alert.attempts >= MAX_ALERT_ATTEMPTS) {
    return { ok: false, reason: "max_attempts_reached" };
  }
  const access = await requireOwnedTarget(alert.target_id, alert.wallet_address);
  if ("error" in access) {
    return { ok: false, reason: access.error === "missing" ? "target_missing" : "wallet_mismatch" };
  }
  const target = access.target;
  if (target.status !== "READY") {
    return { ok: false, reason: `target_${target.status.toLowerCase()}` };
  }
  if (!sameReadyPeriod(alert.ready_since, target.readySince)) {
    return { ok: false, reason: "stale_ready_period" };
  }
  const link = await readActiveLinkForWallet(target.walletAddress);
  if (!link) return { ok: false, reason: "no_active_telegram_link" };
  if (link.wallet_address !== alert.wallet_address || link.wallet_address !== target.walletAddress) {
    return { ok: false, reason: "wallet_mismatch" };
  }
  const payload = prepareReadyAlert(target);
  if (!payload) return { ok: false, reason: "missing_quote_facts" };
  return { ok: true, target, chatId: link.telegram_chat_id, text: payload.text };
}

function retryDelayMs(attempts: number, retryAfterSeconds: number | null): number {
  const backoff = RETRY_BACKOFF_MS[Math.min(attempts, RETRY_BACKOFF_MS.length) - 1] ?? RETRY_BACKOFF_MS[0];
  const requested = retryAfterSeconds != null ? retryAfterSeconds * 1000 : 0;
  return Math.min(Math.max(backoff, requested), MAX_RETRY_DELAY_MS);
}

async function recordSendResult(
  claimed: TargetAlertRow,
  result: TelegramSendResult,
  link: { walletAddress: string; chatId: number },
  now: Date,
): Promise<{ outcome: NotificationOutcome; reason?: string }> {
  const retryable = (lastError: string, retryAfterSeconds: number | null = null) =>
    claimed.attempts >= MAX_ALERT_ATTEMPTS
      ? finishTelegramAlert(claimed, {
          status: "failed_permanent",
          lastError: `${lastError}; max_attempts_reached`,
        }).then(() => ({ outcome: "failed_permanent" as const, reason: lastError }))
      : finishTelegramAlert(claimed, {
          status: "failed_retryable",
          lastError,
          nextAttemptAt: new Date(
            now.getTime() + retryDelayMs(claimed.attempts, retryAfterSeconds),
          ).toISOString(),
        }).then(() => ({ outcome: "failed_retryable" as const, reason: lastError }));

  switch (result.kind) {
    case "sent":
      await finishTelegramAlert(claimed, {
        status: "sent",
        sentAt: now.toISOString(),
        telegramMessageId: result.messageId,
      });
      return { outcome: "sent" };
    case "rate_limited":
      return retryable("telegram_429", result.retryAfterSeconds);
    case "server_error":
      return retryable(`telegram_${result.status}`);
    case "bot_unauthorized":
      return retryable(`telegram_${result.status}_bot_unauthorized`);
    case "rejected": {
      const lastError = `telegram_${result.status}${result.description ? `: ${result.description}` : ""}`;
      await finishTelegramAlert(claimed, { status: "failed_permanent", lastError });
      if (result.chatUnusable) {
        await disableUnreachableTelegramLink(link.walletAddress, link.chatId, now);
      }
      return { outcome: "failed_permanent", reason: `telegram_${result.status}` };
    }
    case "unknown":
      await finishTelegramAlert(claimed, {
        status: "unknown",
        lastError: `telegram_${result.reason}`,
      });
      return { outcome: "unknown", reason: `telegram_${result.reason}` };
  }
}

async function deliverOne(
  alert: TargetAlertRow,
  token: string,
): Promise<{ outcome: NotificationOutcome; reason?: string; stop?: boolean }> {
  const eligibility = await checkEligibility(alert);
  if (!eligibility.ok) {
    await skipTelegramAlert(alert, eligibility.reason);
    return { outcome: "skipped", reason: eligibility.reason };
  }
  const claimed = await claimTelegramAlert(alert, new Date());
  if (!claimed) return { outcome: "claimed_elsewhere" };

  const result = await sendTelegramMessage(token, {
    chatId: eligibility.chatId,
    text: eligibility.text,
    button: { text: OPEN_ORA_BUTTON_TEXT, url: openOraUrl() },
  });
  const recorded = await recordSendResult(
    claimed,
    result,
    { walletAddress: eligibility.target.walletAddress, chatId: eligibility.chatId },
    new Date(),
  );
  return {
    ...recorded,
    stop: result.kind === "rate_limited" || result.kind === "bot_unauthorized",
  };
}

/**
 * Sends due Telegram READY alerts within the caller's deadline. Fails closed
 * when delivery is disabled or misconfigured. Never throws.
 */
export async function deliverTelegramNotifications(options: {
  deadline: number;
  maxSends?: number;
}): Promise<NotificationRun> {
  if (!telegramAlertsEnabled()) return { status: "disabled" };
  const token = telegramBotToken();
  if (!token) {
    console.error("Telegram delivery is enabled but TELEGRAM_BOT_TOKEN is missing or malformed.");
    return { status: "misconfigured" };
  }
  const maxSends = Math.min(options.maxSends ?? MAX_SENDS_PER_RUN, MAX_SENDS_PER_RUN);
  const results: { alertId: string; outcome: NotificationOutcome; reason?: string }[] = [];
  let stoppedEarly = false;

  try {
    await expireInterruptedTelegramClaims(new Date(Date.now() - INTERRUPTED_CLAIM_MS));
    const due = await listDueTelegramAlerts(new Date(), maxSends);
    for (const alert of due) {
      if (options.deadline - Date.now() < MIN_REMAINING_MS) {
        stoppedEarly = true;
        break;
      }
      try {
        const { stop, ...result } = await deliverOne(alert, token);
        results.push({ alertId: alert.id, ...result });
        console.info("Telegram alert delivery:", { alertId: alert.id, ...result });
        if (stop) {
          stoppedEarly = true;
          break;
        }
      } catch (error) {
        console.error(
          `Telegram alert ${alert.id} delivery failed:`,
          error instanceof Error ? error.message : "unknown error",
        );
        results.push({ alertId: alert.id, outcome: "error" });
      }
    }
  } catch (error) {
    console.error(
      "Telegram alert delivery run failed:",
      error instanceof Error ? error.message : "unknown error",
    );
  }
  return { status: "ran", results, stoppedEarly };
}
