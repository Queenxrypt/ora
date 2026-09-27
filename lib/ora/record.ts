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
  const {
    walletAddress: _ignored,
    creditAcquired: _credit,
    totalUsdgPaid: _paid,
    executionPrice: _executionPrice,
    txHash: _txHash,
    confirmedAt: _confirmedAt,
    quotePrice: _quotePrice,
    quotedUsdg: _quotedUsdg,
    quotedAt: _quotedAt,
    validatedBlock: _validatedBlock,
    ...rest
  } = extra;
  void _ignored;
  void _credit;
  void _paid;
  void _executionPrice;
  void _txHash;
  void _confirmedAt;
  void _quotePrice;
  void _quotedUsdg;
  void _quotedAt;
  void _validatedBlock;
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
    minDiscountPercent: decision.params.minDiscountPercent,
    ...(decision.requestedAmount == null
      ? {
          evaluatedRequestedCredit: Math.max(
            decision.params.requestedCredit,
            decision.market.minBuyCredit,
          ),
        }
      : {}),
    ...(decision.executable ? { executable: decision.executable } : {}),
    evaluatedSpendingLimitUsdg: decision.params.spendingLimitUsdg,
  };
}
