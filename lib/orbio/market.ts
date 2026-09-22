import type { DepthLevel, MarketSnapshot } from "../../types/ora";
import { ATOMS, ORBIO_MARKET_ORIGIN } from "./contracts";

export type OrbioBookRow = {
  discountBps: number;
  microUsd: string;
};

export type OrbioBookResponse = {
  rows?: OrbioBookRow[];
  totalMicroUsd?: string;
  minBuyMicroUsd?: string;
  minDiscountBps?: number;
  maxDiscountBps?: number;
  stepBps?: number;
};

export function atomsToUnits(atoms: string | number | bigint): number {
  return Number(atoms) / ATOMS;
}

export function unitsToAtoms(units: number): bigint {
  return BigInt(Math.round(units * ATOMS));
}

export function bpsToPercent(bps: number): number {
  return bps / 100;
}

export function normalizeBook(
  raw: OrbioBookResponse,
  timestamp = new Date().toISOString(),
): MarketSnapshot {
  const rows = Array.isArray(raw.rows) ? raw.rows : [];
  const depth: DepthLevel[] = rows
    .map((row) => ({
      discountPercent: bpsToPercent(row.discountBps),
      availableCredit: atomsToUnits(row.microUsd),
    }))
    .sort((a, b) => b.discountPercent - a.discountPercent);

  const liquid = depth.filter((level) => level.availableCredit > 0);
  const best = liquid[0] ?? {
    discountPercent: 0,
    availableCredit: 0,
  };

  const creditPrice = Number((1 - best.discountPercent / 100).toFixed(6));

  return {
    timestamp,
    creditPrice,
    discountPercent: best.discountPercent,
    bestDiscount: best.discountPercent,
    availableAtBestDiscount: best.availableCredit,
    depth,
    source: "orbio",
    totalAvailableCredit: atomsToUnits(raw.totalMicroUsd ?? 0),
    minBuyCredit: atomsToUnits(raw.minBuyMicroUsd ?? 5_000_000),
  };
}

export async function fetchOrbioBook(): Promise<OrbioBookResponse> {
  const response = await fetch(`${ORBIO_MARKET_ORIGIN}/api/market/book`, {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`Orbio market book unavailable (${response.status})`);
  }
  return (await response.json()) as OrbioBookResponse;
}

export async function readMarketSnapshot(): Promise<MarketSnapshot> {
  const raw = await fetchOrbioBook();
  return normalizeBook(raw);
}
