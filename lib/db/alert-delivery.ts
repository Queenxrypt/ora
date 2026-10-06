import type { TargetAlertRow, TargetAlertStatus } from "./alerts";
import { supabaseAdmin } from "./supabase";

const ALERT_COLUMNS =
  "id, target_id, wallet_address, channel, ready_since, status, attempts, next_attempt_at, claimed_at, sent_at, telegram_message_id, last_error, created_at";

/** Total send attempts per alert, including the first. */
export const MAX_ALERT_ATTEMPTS = 3;

type ClaimableStatus = Extract<TargetAlertStatus, "pending" | "failed_retryable">;

function throwIfError(error: { message: string } | null) {
  if (error) throw new Error(error.message);
}

/**
 * Telegram alerts that may be attempted now: pending, or retryable with
 * attempts left and next_attempt_at passed. Oldest first.
 */
export async function listDueTelegramAlerts(now: Date, limit: number): Promise<TargetAlertRow[]> {
  const nowIso = now.toISOString();
  const [pending, retryable] = await Promise.all([
    supabaseAdmin()
      .from("target_alerts")
      .select(ALERT_COLUMNS)
      .eq("channel", "telegram")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(limit),
    supabaseAdmin()
      .from("target_alerts")
      .select(ALERT_COLUMNS)
      .eq("channel", "telegram")
      .eq("status", "failed_retryable")
      .lt("attempts", MAX_ALERT_ATTEMPTS)
      .lte("next_attempt_at", nowIso)
      .order("created_at", { ascending: true })
      .limit(limit),
  ]);
  throwIfError(pending.error);
  throwIfError(retryable.error);
  return [...((pending.data ?? []) as TargetAlertRow[]), ...((retryable.data ?? []) as TargetAlertRow[])]
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .slice(0, limit);
}

/**
 * Moves the alert to `sending` only if it still has the status and attempt
 * count that were read. Exactly one concurrent caller can win; the rest get null.
 */
export async function claimTelegramAlert(
  alert: Pick<TargetAlertRow, "id" | "status" | "attempts">,
  now: Date,
): Promise<TargetAlertRow | null> {
  if (alert.status !== "pending" && alert.status !== "failed_retryable") return null;
  const status: ClaimableStatus = alert.status;
  let query = supabaseAdmin()
    .from("target_alerts")
    .update({
      status: "sending",
      claimed_at: now.toISOString(),
      attempts: alert.attempts + 1,
    })
    .eq("id", alert.id)
    .eq("status", status)
    .eq("attempts", alert.attempts);
  if (status === "failed_retryable") {
    query = query.lt("attempts", MAX_ALERT_ATTEMPTS).lte("next_attempt_at", now.toISOString());
  }
  const { data, error } = await query.select(ALERT_COLUMNS).maybeSingle();
  throwIfError(error);
  return (data as TargetAlertRow | null) ?? null;
}

/** Records the outcome of a claimed send. Only the claimer's row matches. */
export async function finishTelegramAlert(
  claimed: Pick<TargetAlertRow, "id" | "claimed_at">,
  patch:
    | { status: "sent"; sentAt: string; telegramMessageId: number | null }
    | { status: "failed_retryable"; nextAttemptAt: string; lastError: string }
    | { status: "failed_permanent" | "unknown"; lastError: string },
): Promise<boolean> {
  const update =
    patch.status === "sent"
      ? {
          status: "sent",
          sent_at: patch.sentAt,
          telegram_message_id: patch.telegramMessageId,
          next_attempt_at: null,
          last_error: null,
        }
      : patch.status === "failed_retryable"
        ? { status: "failed_retryable", next_attempt_at: patch.nextAttemptAt, last_error: patch.lastError }
        : { status: patch.status, next_attempt_at: null, last_error: patch.lastError };
  if (!claimed.claimed_at) return false;
  const { data, error } = await supabaseAdmin()
    .from("target_alerts")
    .update(update)
    .eq("id", claimed.id)
    .eq("status", "sending")
    .eq("claimed_at", claimed.claimed_at)
    .select("id");
  throwIfError(error);
  return (data ?? []).length === 1;
}

/** Excludes an unclaimed alert from delivery, only if it is unchanged since it was read. */
export async function skipTelegramAlert(
  alert: Pick<TargetAlertRow, "id" | "status" | "attempts">,
  reason: string,
): Promise<boolean> {
  const { data, error } = await supabaseAdmin()
    .from("target_alerts")
    .update({ status: "skipped", next_attempt_at: null, last_error: reason })
    .eq("id", alert.id)
    .eq("status", alert.status)
    .eq("attempts", alert.attempts)
    .select("id");
  throwIfError(error);
  return (data ?? []).length === 1;
}

/**
 * A `sending` claim older than `staleBefore` belongs to an invocation that
 * stopped mid-send. Telegram may have delivered it, so it becomes `unknown`
 * and is never retried.
 */
export async function expireInterruptedTelegramClaims(staleBefore: Date): Promise<number> {
  const { data, error } = await supabaseAdmin()
    .from("target_alerts")
    .update({ status: "unknown", last_error: "send_interrupted" })
    .eq("channel", "telegram")
    .eq("status", "sending")
    .lt("claimed_at", staleBefore.toISOString())
    .select("id");
  throwIfError(error);
  return (data ?? []).length;
}

/** Disables this exact wallet ↔ chat link after Telegram reports the chat unusable. */
export async function disableUnreachableTelegramLink(
  walletAddress: string,
  telegramChatId: number,
  now: Date,
): Promise<boolean> {
  const nowIso = now.toISOString();
  const { data, error } = await supabaseAdmin()
    .from("telegram_links")
    .update({ disabled_at: nowIso, disabled_reason: "telegram_unreachable", updated_at: nowIso })
    .eq("wallet_address", walletAddress)
    .eq("telegram_chat_id", telegramChatId)
    .is("disabled_at", null)
    .select("wallet_address");
  throwIfError(error);
  return (data ?? []).length === 1;
}
