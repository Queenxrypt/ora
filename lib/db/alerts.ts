import { randomUUID } from "node:crypto";
import { normalizeWalletAddress } from "../ora/wallet";
import { supabaseAdmin } from "./supabase";

export type AlertChannel = "telegram";

export type TargetAlertStatus =
  | "pending"
  | "sending"
  | "sent"
  | "failed_retryable"
  | "failed_permanent"
  | "unknown"
  | "skipped"
  | "suppressed";

export type TargetAlertRow = {
  id: string;
  target_id: string;
  wallet_address: string;
  channel: AlertChannel;
  ready_since: string;
  status: TargetAlertStatus;
  attempts: number;
  next_attempt_at: string | null;
  claimed_at: string | null;
  sent_at: string | null;
  telegram_message_id: number | null;
  last_error: string | null;
  created_at: string;
};

const ALERT_COLUMNS =
  "id, target_id, wallet_address, channel, ready_since, status, attempts, next_attempt_at, claimed_at, sent_at, telegram_message_id, last_error, created_at";

function throwIfError(error: { message: string } | null) {
  if (error) throw new Error(error.message);
}

/**
 * Latest alert for the target and channel whose status is in `statuses`.
 * Used for the cooldown between READY periods.
 */
export async function readLatestTargetAlert(
  targetId: string,
  channel: AlertChannel,
  statuses: readonly TargetAlertStatus[],
): Promise<TargetAlertRow | null> {
  const { data, error } = await supabaseAdmin()
    .from("target_alerts")
    .select(ALERT_COLUMNS)
    .eq("target_id", targetId)
    .eq("channel", channel)
    .in("status", [...statuses])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  throwIfError(error);
  return (data as TargetAlertRow | null) ?? null;
}

/**
 * Creates the alert record for one READY period. Returns null when that
 * period already has a record for the channel.
 *
 * `readySince` must be the database value exactly as read: Postgres keeps
 * microseconds that a JS Date round trip would drop, and the unique key
 * compares the full value.
 */
export async function insertTargetAlert(input: {
  targetId: string;
  walletAddress: string;
  channel: AlertChannel;
  readySince: string;
  status: Extract<TargetAlertStatus, "pending" | "suppressed" | "skipped">;
  lastError?: string | null;
}): Promise<TargetAlertRow | null> {
  const wallet = normalizeWalletAddress(input.walletAddress);
  if (!wallet) throw new Error("walletAddress is required to record an alert.");
  const { data, error } = await supabaseAdmin()
    .from("target_alerts")
    .upsert(
      {
        id: randomUUID(),
        target_id: input.targetId,
        wallet_address: wallet,
        channel: input.channel,
        ready_since: input.readySince,
        status: input.status,
        attempts: 0,
        last_error: input.lastError ?? null,
      },
      { onConflict: "target_id,ready_since,channel", ignoreDuplicates: true },
    )
    .select(ALERT_COLUMNS);
  throwIfError(error);
  const rows = (data ?? []) as TargetAlertRow[];
  return rows[0] ?? null;
}
