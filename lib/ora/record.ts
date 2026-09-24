import { randomUUID } from "node:crypto";
import type { OraDecision, DecisionRecord } from "../../types/ora";
import { normalizeWalletAddress } from "./wallet";

export function recordFromDecision(
  decision: OraDecision,
  extra: Partial<DecisionRecord> = {},
): DecisionRecord {
  const walletAddress = normalizeWalletAddress(extra.walletAddress);
  if (!walletAddress) {
    throw new Error("walletAddress is required to create a decision.");
  }
  const { walletAddress: _ignored, ...rest } = extra;
  void _ignored;
  return {
    id: extra.id ?? randomUUID(),
    timestamp: decision.timestamp,
    market: {
      price: decision.market.creditPrice,
      discountPercent: decision.market.discountPercent,
      availableDepth: decision.market.availableAtBestDiscount,
    },
    snapshot: decision.market,
    decision: decision.action,
    reason: decision.reason,
    requestedAmount: decision.requestedAmount,
    ...rest,
    walletAddress,
    ...(decision.executable ? { executable: decision.executable } : {}),
    evaluatedSpendingLimitUsdg: decision.params.spendingLimitUsdg,
  };
}
