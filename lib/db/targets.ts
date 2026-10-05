import { randomUUID } from "node:crypto";
import type {
  DecisionAction,
  DecisionRecord,
  ProcurementTarget,
  TargetStatus,
} from "../../types/ora";
import { normalizeWalletAddress } from "../ora/wallet";
import {
  evaluationWrite,
  isOpenTargetStatus,
  type ConclusiveTargetEvaluation,
  type TargetParams,
} from "../ora/target";
import { supabaseAdmin } from "./supabase";

export type TargetAccessError = "missing" | "forbidden" | "cancelled" | "fulfilled";

export type TargetRow = {
  id: string;
  wallet_address: string;
  requested_credit: number;
  min_discount_percent: number;
  max_spend_usdg: number;
  status: TargetStatus;
  created_at: string;
  updated_at: string;
  cancelled_at: string | null;
  fulfilled_at: string | null;
  active_decision_id: string | null;
  fulfilled_decision_id: string | null;
  last_evaluated_at: string | null;
  last_evaluation_action: DecisionAction | null;
  last_evaluation_reason: string | null;
  last_requested_amount: number | null;
  last_executable_discount_percent: number | null;
  last_executable_total_usdg: number | null;
  ready_since: string | null;
};

function throwIfError(error: { message: string; code?: string } | null) {
  if (error) throw new Error(error.message);
}

function asNumber(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function rowToTarget(row: TargetRow): ProcurementTarget {
  const walletAddress = normalizeWalletAddress(row.wallet_address);
  if (!walletAddress) {
    throw new Error("procurement target is missing a wallet.");
  }
  return {
    id: row.id,
    walletAddress,
    requestedCredit: Number(row.requested_credit),
    minDiscountPercent: Number(row.min_discount_percent),
    maxSpendUsdg: Number(row.max_spend_usdg),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(asString(row.cancelled_at) ? { cancelledAt: asString(row.cancelled_at) } : {}),
    ...(asString(row.fulfilled_at) ? { fulfilledAt: asString(row.fulfilled_at) } : {}),
    ...(asString(row.active_decision_id)
      ? { activeDecisionId: asString(row.active_decision_id) }
      : {}),
    ...(asString(row.fulfilled_decision_id)
      ? { fulfilledDecisionId: asString(row.fulfilled_decision_id) }
      : {}),
    ...(asString(row.last_evaluated_at)
      ? { lastEvaluatedAt: asString(row.last_evaluated_at) }
      : {}),
    ...(row.last_evaluation_action
      ? { lastEvaluationAction: row.last_evaluation_action }
      : {}),
    ...(asString(row.last_evaluation_reason)
      ? { lastEvaluationReason: asString(row.last_evaluation_reason) }
      : {}),
    ...(asNumber(row.last_requested_amount) != null
      ? { lastRequestedAmount: asNumber(row.last_requested_amount) }
      : {}),
    ...(asNumber(row.last_executable_discount_percent) != null
      ? {
          lastExecutableDiscountPercent: asNumber(
            row.last_executable_discount_percent,
          ),
        }
      : {}),
    ...(asNumber(row.last_executable_total_usdg) != null
      ? { lastExecutableTotalUsdg: asNumber(row.last_executable_total_usdg) }
      : {}),
    ...(asString(row.ready_since) ? { readySince: asString(row.ready_since) } : {}),
  };
}

export function targetBelongsToWallet(
  target: ProcurementTarget,
  walletAddress: string,
): boolean {
  const owner = normalizeWalletAddress(target.walletAddress);
  const wallet = normalizeWalletAddress(walletAddress);
  return owner != null && wallet != null && owner === wallet;
}

const TARGET_COLUMNS =
  "id, wallet_address, requested_credit, min_discount_percent, max_spend_usdg, status, created_at, updated_at, cancelled_at, fulfilled_at, active_decision_id, fulfilled_decision_id, last_evaluated_at, last_evaluation_action, last_evaluation_reason, last_requested_amount, last_executable_discount_percent, last_executable_total_usdg, ready_since";

export async function insertTarget(
  walletAddress: string,
  params: TargetParams,
): Promise<ProcurementTarget> {
  const wallet = normalizeWalletAddress(walletAddress);
  if (!wallet) throw new Error("walletAddress is required to create a target.");
  const now = new Date().toISOString();
  const { data, error } = await supabaseAdmin()
    .from("procurement_targets")
    .insert({
      id: randomUUID(),
      wallet_address: wallet,
      requested_credit: params.requestedCredit,
      min_discount_percent: params.minDiscountPercent,
      max_spend_usdg: params.maxSpendUsdg,
      status: "WATCHING",
      created_at: now,
      updated_at: now,
    })
    .select(TARGET_COLUMNS)
    .single();
  if (error?.code === "23505") {
    throw new OpenTargetExistsError();
  }
  throwIfError(error);
  if (!data) throw new Error("Target was not persisted.");
  return rowToTarget(data as TargetRow);
}

export class OpenTargetExistsError extends Error {
  constructor() {
    super("This wallet already has an open procurement target.");
    this.name = "OpenTargetExistsError";
  }
}

export async function readOpenTarget(
  walletAddress: string,
): Promise<ProcurementTarget | null> {
  const wallet = normalizeWalletAddress(walletAddress);
  if (!wallet) return null;
  const { data, error } = await supabaseAdmin()
    .from("procurement_targets")
    .select(TARGET_COLUMNS)
    .eq("wallet_address", wallet)
    .in("status", ["WATCHING", "READY"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  throwIfError(error);
  if (!data) return null;
  const target = rowToTarget(data as TargetRow);
  return targetBelongsToWallet(target, wallet) ? target : null;
}

export async function readLatestFulfilledTarget(
  walletAddress: string,
): Promise<ProcurementTarget | null> {
  const wallet = normalizeWalletAddress(walletAddress);
  if (!wallet) return null;
  const { data, error } = await supabaseAdmin()
    .from("procurement_targets")
    .select(TARGET_COLUMNS)
    .eq("wallet_address", wallet)
    .eq("status", "FULFILLED")
    .order("fulfilled_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  throwIfError(error);
  if (!data) return null;
  const target = rowToTarget(data as TargetRow);
  return targetBelongsToWallet(target, wallet) ? target : null;
}

export async function readTargetForWallet(
  walletAddress: string,
): Promise<ProcurementTarget | null> {
  const open = await readOpenTarget(walletAddress);
  if (open) return open;
  return readLatestFulfilledTarget(walletAddress);
}

export async function readOpenTargets(): Promise<ProcurementTarget[]> {
  const { data, error } = await supabaseAdmin()
    .from("procurement_targets")
    .select(TARGET_COLUMNS)
    .in("status", ["WATCHING", "READY"])
    .order("created_at", { ascending: true })
    .limit(200);
  throwIfError(error);
  return ((data ?? []) as TargetRow[]).map(rowToTarget);
}

export async function requireOwnedTarget(
  id: string,
  walletAddress: string,
): Promise<{ target: ProcurementTarget } | { error: TargetAccessError }> {
  const wallet = normalizeWalletAddress(walletAddress);
  if (!wallet) return { error: "forbidden" };
  const { data, error } = await supabaseAdmin()
    .from("procurement_targets")
    .select(TARGET_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  throwIfError(error);
  if (!data) return { error: "missing" };
  const target = rowToTarget(data as TargetRow);
  if (!targetBelongsToWallet(target, wallet)) return { error: "forbidden" };
  return { target };
}

function evaluationRowPatch(
  evaluation: ConclusiveTargetEvaluation,
  now = new Date(),
) {
  const write = evaluationWrite(evaluation, now);
  return {
    status: write.status,
    last_evaluated_at: write.lastEvaluatedAt,
    last_evaluation_action: write.lastEvaluationAction,
    last_evaluation_reason: write.lastEvaluationReason,
    last_requested_amount: write.lastRequestedAmount,
    last_executable_discount_percent: write.lastExecutableDiscountPercent,
    last_executable_total_usdg: write.lastExecutableTotalUsdg,
    updated_at: write.updatedAt,
  };
}

/**
 * Writes an evaluation only if the row is unchanged since `evaluated` was read.
 * Every target write sets updated_at, so a newer evaluation, review link,
 * reopen, cancel or fulfilment makes this a no-op that returns null.
 */
export async function persistTargetEvaluation(
  evaluated: Pick<ProcurementTarget, "id" | "walletAddress" | "updatedAt">,
  evaluation: ConclusiveTargetEvaluation,
): Promise<ProcurementTarget | null> {
  const wallet = normalizeWalletAddress(evaluated.walletAddress);
  if (!wallet) return null;
  const { data, error } = await supabaseAdmin()
    .from("procurement_targets")
    .update(evaluationRowPatch(evaluation))
    .eq("id", evaluated.id)
    .eq("wallet_address", wallet)
    .eq("updated_at", evaluated.updatedAt)
    .in("status", ["WATCHING", "READY"])
    .select(TARGET_COLUMNS)
    .maybeSingle();
  throwIfError(error);
  return data ? rowToTarget(data as TargetRow) : null;
}

export async function cancelOwnedTarget(
  id: string,
  walletAddress: string,
): Promise<{ target: ProcurementTarget } | { error: TargetAccessError }> {
  const access = await requireOwnedTarget(id, walletAddress);
  if ("error" in access) return access;
  if (access.target.status === "CANCELLED") return { error: "cancelled" };
  if (access.target.status === "FULFILLED") return { error: "fulfilled" };
  const now = new Date().toISOString();
  const wallet = normalizeWalletAddress(walletAddress);
  if (!wallet) return { error: "forbidden" };
  const { data, error } = await supabaseAdmin()
    .from("procurement_targets")
    .update({
      status: "CANCELLED",
      cancelled_at: now,
      updated_at: now,
      last_executable_discount_percent: null,
      last_executable_total_usdg: null,
    })
    .eq("id", id)
    .eq("wallet_address", wallet)
    .in("status", ["WATCHING", "READY"])
    .select(TARGET_COLUMNS)
    .maybeSingle();
  throwIfError(error);
  if (!data) {
    const latest = await requireOwnedTarget(id, walletAddress);
    if ("error" in latest) return latest;
    if (latest.target.status === "CANCELLED") return { error: "cancelled" };
    if (latest.target.status === "FULFILLED") return { error: "fulfilled" };
    return { error: "missing" };
  }
  return { target: rowToTarget(data as TargetRow) };
}

export async function setActiveDecision(
  id: string,
  walletAddress: string,
  decisionId: string,
): Promise<ProcurementTarget | null> {
  const wallet = normalizeWalletAddress(walletAddress);
  if (!wallet) return null;
  const { data, error } = await supabaseAdmin()
    .from("procurement_targets")
    .update({
      active_decision_id: decisionId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("wallet_address", wallet)
    .in("status", ["WATCHING", "READY"])
    .select(TARGET_COLUMNS)
    .maybeSingle();
  throwIfError(error);
  return data ? rowToTarget(data as TargetRow) : null;
}

export async function fulfillTargetFromDecision(
  record: DecisionRecord,
): Promise<ProcurementTarget | null> {
  if (!record.targetId || record.executionStatus !== "success") return null;
  const wallet = normalizeWalletAddress(record.walletAddress);
  if (!wallet) return null;
  const now = record.confirmedAt ?? new Date().toISOString();
  const { data, error } = await supabaseAdmin()
    .from("procurement_targets")
    .update({
      status: "FULFILLED",
      fulfilled_at: now,
      fulfilled_decision_id: record.id,
      updated_at: now,
    })
    .eq("id", record.targetId)
    .eq("wallet_address", wallet)
    .in("status", ["WATCHING", "READY"])
    .select(TARGET_COLUMNS)
    .maybeSingle();
  throwIfError(error);
  return data ? rowToTarget(data as TargetRow) : null;
}

export async function reopenTargetFromDecision(
  record: DecisionRecord,
): Promise<ProcurementTarget | null> {
  if (!record.targetId) return null;
  const wallet = normalizeWalletAddress(record.walletAddress);
  if (!wallet) return null;
  const now = new Date().toISOString();
  const { data, error } = await supabaseAdmin()
    .from("procurement_targets")
    .update({
      status: "WATCHING",
      updated_at: now,
      last_evaluated_at: now,
      last_executable_discount_percent: null,
      last_executable_total_usdg: null,
      active_decision_id: null,
    })
    .eq("id", record.targetId)
    .eq("wallet_address", wallet)
    .in("status", ["WATCHING", "READY"])
    .select(TARGET_COLUMNS)
    .maybeSingle();
  throwIfError(error);
  return data ? rowToTarget(data as TargetRow) : null;
}

export async function tryFulfillTargetFromDecision(
  record: DecisionRecord,
): Promise<ProcurementTarget | null> {
  try {
    return await fulfillTargetFromDecision(record);
  } catch (error) {
    console.error(
      "Could not fulfill procurement target after receipt:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

export async function tryReopenTargetFromDecision(
  record: DecisionRecord,
): Promise<ProcurementTarget | null> {
  try {
    return await reopenTargetFromDecision(record);
  } catch (error) {
    console.error(
      "Could not reopen procurement target after a failed purchase:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

export function targetAccessResponse(error: TargetAccessError) {
  if (error === "missing") {
    return { status: 404 as const, error: "Unknown target." };
  }
  if (error === "cancelled") {
    return { status: 409 as const, error: "This target is cancelled." };
  }
  if (error === "fulfilled") {
    return { status: 409 as const, error: "This target is already complete." };
  }
  return { status: 403 as const, error: "This target does not belong to this wallet." };
}

export { isOpenTargetStatus };
