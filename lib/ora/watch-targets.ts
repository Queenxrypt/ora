import type { ExecutableTerms, MarketSnapshot, ProcurementTarget } from "../../types/ora";
import type { ObservedBook } from "../orbio/book-observation";
import { quoteForCredit } from "../orbio/exchange";
import { readMarketSnapshot } from "../orbio/market";
import { requireOwnedDecision } from "../db/store";
import {
  persistTargetEvaluation,
  readOpenTargets,
  requireOwnedTarget,
} from "../db/targets";
import {
  evaluateTarget,
  executableTermsFromQuote,
  isPurchaseInFlight,
  marketSnapshotFromObservedBook,
  paramsFromTarget,
  type TargetQuoteFn,
} from "./target";

const OBSERVATION_QUOTE_BUDGET_MS = 8_000;
const OBSERVATION_QUOTE_CAP = 5;

export type TargetWatchOutcome =
  | { kind: "written"; target: ProcurementTarget }
  | { kind: "inconclusive" | "in_flight" | "superseded" };

export type TargetWatchResult = {
  targetId: string;
  result: TargetWatchOutcome["kind"] | "error";
};

export async function quoteTargetTerms(
  requestedCredit: number,
): Promise<ExecutableTerms | null> {
  try {
    const quoted = await quoteForCredit(requestedCredit);
    return executableTermsFromQuote(quoted);
  } catch (error) {
    const message = error instanceof Error ? error.message : "quote failed";
    console.error("Target executable quote unavailable:", message);
    return null;
  }
}

/** Resolves null when the quote does not settle within `ms`. */
async function quoteWithin(
  requestedCredit: number,
  ms: number,
): Promise<ExecutableTerms | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      console.error("Target executable quote unavailable: timed out");
      resolve(null);
    }, ms);
  });
  try {
    return await Promise.race([quoteTargetTerms(requestedCredit), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** True when the target's active decision is awaiting signature or pending onchain. */
export async function targetPurchaseInFlight(
  target: Pick<ProcurementTarget, "activeDecisionId" | "walletAddress">,
): Promise<boolean> {
  if (!target.activeDecisionId) return false;
  const access = await requireOwnedDecision(
    target.activeDecisionId,
    target.walletAddress,
  );
  return "record" in access && isPurchaseInFlight(access.record);
}

/**
 * Evaluates one open target and writes the result only when it is conclusive,
 * no purchase is in flight, and the row has not changed since it was read.
 */
export async function evaluateAndPersistTarget(
  target: ProcurementTarget,
  market: MarketSnapshot,
  quote: TargetQuoteFn | undefined,
): Promise<TargetWatchOutcome> {
  if (await targetPurchaseInFlight(target)) return { kind: "in_flight" };
  const evaluation = await evaluateTarget(market, paramsFromTarget(target), quote);
  if (evaluation.outcome === "INCONCLUSIVE") return { kind: "inconclusive" };
  if (await targetPurchaseInFlight(target)) return { kind: "in_flight" };
  const written = await persistTargetEvaluation(target, evaluation);
  return written ? { kind: "written", target: written } : { kind: "superseded" };
}

/**
 * After a succeeded observation: cheap book screen for every open target,
 * then quote only when the book can fill the full requested amount.
 * Each target is isolated; failures here must not fail the observation.
 */
export async function evaluateOpenTargetsAfterObservation(
  book: ObservedBook,
): Promise<TargetWatchResult[]> {
  const market = marketSnapshotFromObservedBook({
    levels: book.levels,
    minBuyCreditAtoms: book.minBuyCreditAtoms,
    reportedTotalCreditAtoms: book.reportedTotalCreditAtoms,
  });
  const open = await readOpenTargets();
  if (open.length === 0) return [];

  const deadline = Date.now() + OBSERVATION_QUOTE_BUDGET_MS;
  let quotes = 0;
  const results: TargetWatchResult[] = [];

  for (const target of open) {
    const remaining = deadline - Date.now();
    const canQuote = quotes < OBSERVATION_QUOTE_CAP && remaining > 500;
    try {
      const outcome = await evaluateAndPersistTarget(
        target,
        market,
        canQuote
          ? async (requestedCredit) => {
              quotes += 1;
              return quoteWithin(
                requestedCredit,
                Math.max(0, deadline - Date.now()),
              );
            }
          : undefined,
      );
      results.push({ targetId: target.id, result: outcome.kind });
    } catch (error) {
      console.error(
        `Procurement target ${target.id} evaluation failed:`,
        error instanceof Error ? error.message : error,
      );
      results.push({ targetId: target.id, result: "error" });
    }
  }
  return results;
}

/** Live evaluation for the owner's page load. Returns the latest stored target. */
export async function evaluateOwnedTargetLive(
  target: ProcurementTarget,
): Promise<ProcurementTarget | null> {
  const market = await readMarketSnapshot();
  const outcome = await evaluateAndPersistTarget(target, market, quoteTargetTerms);
  if (outcome.kind === "written") return outcome.target;
  const latest = await requireOwnedTarget(target.id, target.walletAddress);
  return "target" in latest ? latest.target : null;
}
