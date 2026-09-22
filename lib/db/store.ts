import type {
  DecisionRecord,
  PerformanceSummary,
  UserSettings,
} from "../../types/ora";
import { DEFAULT_PARAMS } from "../ora/decision";
import { normalizeWalletAddress } from "../ora/wallet";
import {
  normalizeSettings,
  patchToRow,
  recordToRow,
  rowToRecord,
  settingsFromRow,
  type DecisionRow,
} from "./rows";
import { supabaseAdmin } from "./supabase";

export type DecisionAccessError = "missing" | "forbidden";

function throwIfError(error: { message: string } | null) {
  if (error) throw new Error(error.message);
}

export function recordBelongsToWallet(
  record: DecisionRecord,
  walletAddress: string,
): boolean {
  const owner = normalizeWalletAddress(record.walletAddress);
  const wallet = normalizeWalletAddress(walletAddress);
  return owner != null && wallet != null && owner === wallet;
}

export async function readLedger(): Promise<DecisionRecord[]> {
  const { data, error } = await supabaseAdmin()
    .from("decisions")
    .select("*")
    .order("timestamp", { ascending: false });
  throwIfError(error);
  return ((data ?? []) as DecisionRow[]).map(rowToRecord);
}

export async function readLedgerForWallet(
  walletAddress: string,
): Promise<DecisionRecord[]> {
  const wallet = normalizeWalletAddress(walletAddress);
  if (!wallet) return [];
  const { data, error } = await supabaseAdmin()
    .from("decisions")
    .select("*")
    .eq("wallet_address", wallet)
    .order("timestamp", { ascending: false });
  throwIfError(error);
  return ((data ?? []) as DecisionRow[])
    .map(rowToRecord)
    .filter((item) => recordBelongsToWallet(item, wallet));
}

export async function writeLedger(decisions: DecisionRecord[]) {
  const db = supabaseAdmin();
  for (const record of decisions) {
    const wallet = normalizeWalletAddress(record.walletAddress);
    if (!wallet) continue;
    const { error } = await db
      .from("decisions")
      .upsert(recordToRow({ ...record, walletAddress: wallet }), {
        onConflict: "id",
      });
    throwIfError(error);
  }
}

export async function appendDecision(
  record: DecisionRecord,
): Promise<DecisionRecord> {
  const walletAddress = normalizeWalletAddress(record.walletAddress);
  if (!walletAddress) {
    throw new Error("walletAddress is required to create a decision.");
  }
  const owned: DecisionRecord = { ...record, walletAddress };
  const { data, error } = await supabaseAdmin()
    .from("decisions")
    .insert(recordToRow(owned))
    .select("*")
    .single();
  throwIfError(error);
  if (!data) throw new Error("Decision was not persisted.");
  return rowToRecord(data as DecisionRow);
}

export async function requireOwnedDecision(
  id: string,
  walletAddress: string,
): Promise<{ record: DecisionRecord } | { error: DecisionAccessError }> {
  const wallet = normalizeWalletAddress(walletAddress);
  if (!wallet) return { error: "forbidden" };
  const { data, error } = await supabaseAdmin()
    .from("decisions")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  throwIfError(error);
  if (!data) return { error: "missing" };
  const record = rowToRecord(data as DecisionRow);
  if (!recordBelongsToWallet(record, wallet)) return { error: "forbidden" };
  return { record };
}

export async function updateOwnedDecision(
  id: string,
  walletAddress: string,
  patch: Partial<DecisionRecord>,
): Promise<{ record: DecisionRecord } | { error: DecisionAccessError }> {
  const access = await requireOwnedDecision(id, walletAddress);
  if ("error" in access) return access;
  const wallet = normalizeWalletAddress(walletAddress);
  if (!wallet) return { error: "forbidden" };
  const { walletAddress: _ignored, ...rest } = patch;
  void _ignored;
  const rowPatch = patchToRow(rest);
  const { data, error } = await supabaseAdmin()
    .from("decisions")
    .update(rowPatch)
    .eq("id", id)
    .eq("wallet_address", wallet)
    .select("*")
    .maybeSingle();
  throwIfError(error);
  if (!data) return { error: "missing" };
  return { record: rowToRecord(data as DecisionRow) };
}

export async function readSettings(
  walletAddress?: string | null,
): Promise<UserSettings> {
  const wallet = normalizeWalletAddress(walletAddress);
  if (!wallet) {
    return { ...DEFAULT_PARAMS };
  }
  const { data, error } = await supabaseAdmin()
    .from("settings")
    .select("*")
    .eq("wallet_address", wallet)
    .maybeSingle();
  throwIfError(error);
  if (!data) return { ...DEFAULT_PARAMS, walletAddress: wallet };
  return settingsFromRow(data);
}

export async function writeSettings(
  settings: UserSettings,
): Promise<UserSettings> {
  const wallet = normalizeWalletAddress(settings.walletAddress);
  if (!wallet) {
    throw new Error("walletAddress is required to save settings.");
  }
  const next = normalizeSettings({
    ...DEFAULT_PARAMS,
    ...settings,
    walletAddress: wallet,
  });
  const { data, error } = await supabaseAdmin()
    .from("settings")
    .upsert(
      {
        wallet_address: wallet,
        requested_credit: next.requestedCredit,
        spending_limit_usdg: next.spendingLimitUsdg,
        min_discount_percent: next.minDiscountPercent,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "wallet_address" },
    )
    .select("*")
    .single();
  throwIfError(error);
  if (!data) throw new Error("Settings were not persisted.");
  return settingsFromRow(data);
}

export function performanceFrom(
  decisions: DecisionRecord[],
): PerformanceSummary {
  const buys = decisions.filter((d) => d.decision === "BUY");
  const waits = decisions.filter((d) => d.decision === "WAIT");
  const executed = decisions.filter(
    (d) => d.decision === "BUY" && d.executionStatus === "success",
  );
  const totalCreditPurchased = executed.reduce(
    (sum, d) => sum + (d.creditAcquired ?? 0),
    0,
  );
  const totalProcurementCost = executed.reduce(
    (sum, d) => sum + (d.totalUsdgPaid ?? 0),
    0,
  );
  const averageEffectivePrice =
    totalCreditPurchased > 0
      ? Number((totalProcurementCost / totalCreditPurchased).toFixed(6))
      : null;

  const enoughData = executed.length >= 3;

  return {
    totalCreditPurchased,
    averageEffectivePrice,
    totalProcurementCost,
    comparableBuyOnDemandCost: null,
    difference: null,
    buyCount: buys.length,
    waitCount: waits.length,
    successfulExecutions: executed.length,
    unresolvedCount: 0,
    enoughData,
    note: enoughData
      ? "Figures are a running comparison, not a proof that Ora is a better strategy."
      : "Too few recorded decisions to treat this as a strategy result. Numbers are shown as a log, not a score.",
  };
}
