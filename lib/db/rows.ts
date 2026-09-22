import type {
  DecisionAction,
  DecisionRecord,
  ExecutionStatus,
  MarketSnapshot,
  OraReasoning,
  UserSettings,
} from "../../types/ora";
import { DEFAULT_PARAMS } from "../ora/decision";
import { normalizeWalletAddress } from "../ora/wallet";

export type DecisionRow = {
  id: string;
  wallet_address: string;
  timestamp: string;
  market: DecisionRecord["market"];
  snapshot: MarketSnapshot;
  decision: DecisionAction;
  reason: string;
  requested_amount: number | null;
  quote_price: number | null;
  quoted_usdg: number | null;
  quoted_at: string | null;
  execution_price: number | null;
  tx_hash: string | null;
  execution_status: ExecutionStatus | null;
  blocked_reason: string | null;
  credit_acquired: number | null;
  total_usdg_paid: number | null;
  confirmed_at: string | null;
  reasoning: OraReasoning | null;
};

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

function optionalNumber(value: unknown): number | null {
  const n = asNumber(value);
  return n == null ? null : n;
}

export function recordToRow(record: DecisionRecord): DecisionRow {
  const walletAddress = normalizeWalletAddress(record.walletAddress);
  if (!walletAddress) {
    throw new Error("walletAddress is required to persist a decision.");
  }
  return {
    id: record.id,
    wallet_address: walletAddress,
    timestamp: record.timestamp,
    market: record.market,
    snapshot: record.snapshot,
    decision: record.decision,
    reason: record.reason,
    requested_amount: optionalNumber(record.requestedAmount),
    quote_price: optionalNumber(record.quotePrice),
    quoted_usdg: optionalNumber(record.quotedUsdg),
    quoted_at: asString(record.quotedAt) ?? null,
    execution_price: optionalNumber(record.executionPrice),
    tx_hash: asString(record.txHash) ?? null,
    execution_status: record.executionStatus ?? null,
    blocked_reason: asString(record.blockedReason) ?? null,
    credit_acquired: optionalNumber(record.creditAcquired),
    total_usdg_paid: optionalNumber(record.totalUsdgPaid),
    confirmed_at: asString(record.confirmedAt) ?? null,
    reasoning: record.reasoning ?? null,
  };
}

export function rowToRecord(row: DecisionRow): DecisionRecord {
  const walletAddress = normalizeWalletAddress(row.wallet_address) ?? undefined;
  return {
    id: row.id,
    timestamp: row.timestamp,
    market: row.market,
    snapshot: row.snapshot,
    decision: row.decision,
    reason: row.reason,
    requestedAmount: asNumber(row.requested_amount),
    quotePrice: asNumber(row.quote_price),
    quotedUsdg: asNumber(row.quoted_usdg),
    quotedAt: asString(row.quoted_at),
    executionPrice: asNumber(row.execution_price),
    txHash: asString(row.tx_hash),
    executionStatus: row.execution_status ?? undefined,
    blockedReason: asString(row.blocked_reason),
    creditAcquired: asNumber(row.credit_acquired),
    totalUsdgPaid: asNumber(row.total_usdg_paid),
    confirmedAt: asString(row.confirmed_at),
    ...(walletAddress ? { walletAddress } : {}),
    ...(row.reasoning ? { reasoning: row.reasoning } : {}),
  };
}

export function patchToRow(
  patch: Partial<DecisionRecord>,
): Partial<DecisionRow> {
  const row: Partial<DecisionRow> = {};
  if ("timestamp" in patch && patch.timestamp)
    row.timestamp = patch.timestamp;
  if ("market" in patch && patch.market) row.market = patch.market;
  if ("snapshot" in patch && patch.snapshot) row.snapshot = patch.snapshot;
  if ("decision" in patch && patch.decision) row.decision = patch.decision;
  if ("reason" in patch && patch.reason) row.reason = patch.reason;
  if ("requestedAmount" in patch)
    row.requested_amount = optionalNumber(patch.requestedAmount);
  if ("quotePrice" in patch) row.quote_price = optionalNumber(patch.quotePrice);
  if ("quotedUsdg" in patch) row.quoted_usdg = optionalNumber(patch.quotedUsdg);
  if ("quotedAt" in patch) row.quoted_at = asString(patch.quotedAt) ?? null;
  if ("executionPrice" in patch)
    row.execution_price = optionalNumber(patch.executionPrice);
  if ("txHash" in patch) row.tx_hash = asString(patch.txHash) ?? null;
  if ("executionStatus" in patch)
    row.execution_status = patch.executionStatus ?? null;
  if ("blockedReason" in patch)
    row.blocked_reason = asString(patch.blockedReason) ?? null;
  if ("creditAcquired" in patch)
    row.credit_acquired = optionalNumber(patch.creditAcquired);
  if ("totalUsdgPaid" in patch)
    row.total_usdg_paid = optionalNumber(patch.totalUsdgPaid);
  if ("confirmedAt" in patch)
    row.confirmed_at = asString(patch.confirmedAt) ?? null;
  if ("reasoning" in patch) row.reasoning = patch.reasoning ?? null;
  return row;
}

export function normalizeSettings(
  raw: Partial<UserSettings> & { minAvailableCredit?: number },
): UserSettings {
  const { minAvailableCredit: _removed, ...rest } = raw;
  void _removed;
  const walletAddress = normalizeWalletAddress(rest.walletAddress);
  return {
    spendingLimitUsdg:
      rest.spendingLimitUsdg ?? DEFAULT_PARAMS.spendingLimitUsdg,
    minDiscountPercent:
      rest.minDiscountPercent ?? DEFAULT_PARAMS.minDiscountPercent,
    requestedCredit: rest.requestedCredit ?? DEFAULT_PARAMS.requestedCredit,
    ...(walletAddress ? { walletAddress } : {}),
  };
}

export function settingsFromRow(row: {
  wallet_address: string;
  requested_credit: number;
  spending_limit_usdg: number;
  min_discount_percent: number;
}): UserSettings {
  return normalizeSettings({
    walletAddress: row.wallet_address,
    requestedCredit: asNumber(row.requested_credit),
    spendingLimitUsdg: asNumber(row.spending_limit_usdg),
    minDiscountPercent: asNumber(row.min_discount_percent),
  });
}
