import type { MarketSnapshot } from "../../types/ora";

/** Listed CREDIT price on a recorded book: CREDIT × creditPrice. */
export function buyOnDemandCost(
  creditAmount: number,
  market: MarketSnapshot,
): number {
  return Number((creditAmount * market.creditPrice).toFixed(6));
}

export function effectivePrice(usdgPaid: number, creditAcquired: number): number {
  if (creditAcquired <= 0) return 0;
  return Number((usdgPaid / creditAcquired).toFixed(6));
}

export function discountFromPrice(price: number): number {
  return Number(((1 - price) * 100).toFixed(4));
}
