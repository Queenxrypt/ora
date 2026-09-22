import type {
  DepthLevel,
  MarketSnapshot,
  OraDecision,
  ProcurementParams,
} from "../../types/ora";

export const DEFAULT_PARAMS: ProcurementParams = {
  minDiscountPercent: 20,
  requestedCredit: 5,
  spendingLimitUsdg: 25,
};

export function decide(
  market: MarketSnapshot,
  params: ProcurementParams,
): OraDecision {
  const timestamp = new Date().toISOString();
  const requested = Math.max(params.requestedCredit, market.minBuyCredit);

  const qualifying = market.depth.filter(
    (level) => level.discountPercent >= params.minDiscountPercent,
  );
  const fillable = qualifying.filter(
    (level) => level.availableCredit >= requested,
  );

  if (fillable.length === 0) {
    return {
      action: "WAIT",
      timestamp,
      market,
      reason: waitReason(market, params, requested, qualifying),
      params,
    };
  }

  const chosen = fillable[0];
  return {
    action: "BUY",
    timestamp,
    market,
    requestedAmount: requested,
    params,
    reason: `${chosen.discountPercent}% discount meets your ${params.minDiscountPercent}% threshold and enough CREDIT is available to fulfill your ${formatCredit(requested)} CREDIT request.`,
  };
}

function waitReason(
  market: MarketSnapshot,
  params: ProcurementParams,
  requested: number,
  qualifying: DepthLevel[],
): string {
  const bestQualifying = qualifying[0];
  if (bestQualifying) {
    return `${bestQualifying.discountPercent}% discount meets your ${params.minDiscountPercent}% threshold, but only ${formatCredit(bestQualifying.availableCredit)} CREDIT is available at that level. You requested ${formatCredit(requested)} CREDIT.`;
  }
  return `Best available discount is ${market.bestDiscount}%, below your ${params.minDiscountPercent}% threshold.`;
}

function formatCredit(value: number): string {
  return value.toLocaleString("en-US", {
    maximumFractionDigits: 2,
  });
}
