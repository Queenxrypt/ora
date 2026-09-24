import type {
  DecisionAction,
  DecisionRecord,
  ExecutionStatus,
  MarketSnapshot,
  ProcurementParams,
} from "../../types/ora";
import { decide, decideWithExecutableQuote } from "./decision";

const REVIEWABLE: ExecutionStatus[] = ["none", "quoting", "review"];
const TERMINAL: ExecutionStatus[] = [
  "success",
  "failed",
  "stale_quote",
  "blocked_limit",
  "blocked_liquidity",
  "blocked_funds",
];

export function evaluationKey(
  wallet: string,
  market: MarketSnapshot,
  params: ProcurementParams,
): string {
  const depth = market.depth
    .map((level) => `${level.discountPercent}:${level.availableCredit}`)
    .join("|");
  return [
    wallet.trim().toLowerCase(),
    params.requestedCredit,
    params.minDiscountPercent,
    params.spendingLimitUsdg,
    market.minBuyCredit,
    market.bestDiscount,
    market.creditPrice,
    depth,
  ].join("~");
}

export function sameMarketEvaluation(
  recorded: MarketSnapshot,
  current: MarketSnapshot,
): boolean {
  if (
    recorded.bestDiscount !== current.bestDiscount ||
    recorded.creditPrice !== current.creditPrice ||
    recorded.minBuyCredit !== current.minBuyCredit ||
    recorded.depth.length !== current.depth.length
  ) {
    return false;
  }
  return recorded.depth.every(
    (level, index) =>
      level.discountPercent === current.depth[index]?.discountPercent &&
      level.availableCredit === current.depth[index]?.availableCredit,
  );
}

export function sameRecordedEvaluation(
  record: DecisionRecord,
  market: MarketSnapshot,
  params: ProcurementParams,
): boolean {
  if (record.evaluatedSpendingLimitUsdg != null) {
    if (record.evaluatedSpendingLimitUsdg !== params.spendingLimitUsdg) {
      return false;
    }
  } else if (record.executable) {
    return false;
  }
  const live = record.executable
    ? decideWithExecutableQuote(market, params, record.executable)
    : decide(market, params);
  if (record.decision !== live.action) return false;
  if (record.reason !== live.reason) return false;
  if ((record.requestedAmount ?? null) !== (live.requestedAmount ?? null)) {
    return false;
  }
  return sameMarketEvaluation(record.snapshot, market);
}

export function settingsReadyForEvaluation(
  wallet: string | null | undefined,
  settings: { walletAddress?: string } | null | undefined,
): boolean {
  if (!wallet || !settings?.walletAddress) return false;
  return settings.walletAddress.toLowerCase() === wallet.trim().toLowerCase();
}

export function canReviewDecision(record: DecisionRecord): boolean {
  const status = record.executionStatus ?? "none";
  return REVIEWABLE.includes(status);
}

export function isTerminalDecision(record: DecisionRecord): boolean {
  return record.executionStatus != null && TERMINAL.includes(record.executionStatus);
}

export function nextEvaluationAction(input: {
  wallet: string | null | undefined;
  market: MarketSnapshot | null;
  params: (ProcurementParams & { walletAddress?: string }) | null;
  lastKey: string | null;
  inFlightKey: string | null;
  latest: DecisionRecord | null;
}):
  | { type: "persist"; key: string }
  | { type: "adopt"; key: string }
  | {
      type: "skip";
      reason:
        | "disconnected"
        | "incomplete"
        | "settings-unready"
        | "duplicate"
        | "in-flight"
        | "terminal"
        | "closed";
    } {
  if (!input.wallet) return { type: "skip", reason: "disconnected" };
  if (!input.market || !input.params) {
    return { type: "skip", reason: "incomplete" };
  }
  if (!settingsReadyForEvaluation(input.wallet, input.params)) {
    return { type: "skip", reason: "settings-unready" };
  }
  const key = evaluationKey(input.wallet, input.market, input.params);
  if (key === input.lastKey) return { type: "skip", reason: "duplicate" };
  if (key === input.inFlightKey) return { type: "skip", reason: "in-flight" };
  const latestWallet = input.latest?.walletAddress?.toLowerCase();
  if (
    input.lastKey === null &&
    input.latest &&
    latestWallet === input.wallet.trim().toLowerCase() &&
    sameRecordedEvaluation(input.latest, input.market, input.params)
  ) {
    if (!canReviewDecision(input.latest)) {
      return {
        type: "skip",
        reason: isTerminalDecision(input.latest) ? "terminal" : "closed",
      };
    }
    return { type: "adopt", key };
  }
  return { type: "persist", key };
}

export function shouldRequestQuote(
  action: DecisionAction | null | undefined,
): boolean {
  return action === "BUY";
}
