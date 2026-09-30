import type { ExecutableTerms, MarketSnapshot, ProcurementTarget } from "../../types/ora";
import type { ObservedBook } from "../orbio/book-observation";
import { quoteForCredit } from "../orbio/exchange";
import { readMarketSnapshot } from "../orbio/market";
import {
  persistTargetEvaluation,
  readOpenTargets,
} from "../db/targets";
import {
  evaluateTarget,
  executableTermsFromQuote,
  marketSnapshotFromObservedBook,
  paramsFromTarget,
} from "./target";

const OBSERVATION_QUOTE_BUDGET_MS = 8_000;
const OBSERVATION_QUOTE_CAP = 5;

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

export async function evaluateAndPersistTarget(
  target: ProcurementTarget,
  market: MarketSnapshot,
  quote = quoteTargetTerms,
): Promise<ProcurementTarget | null> {
  const evaluation = await evaluateTarget(market, paramsFromTarget(target), quote);
  return persistTargetEvaluation(target.id, target.walletAddress, evaluation);
}

/**
 * After a succeeded observation: cheap book screen for every open target,
 * then quote only when the book can fill the full requested amount.
 * Failures here must not fail the observation itself.
 */
export async function evaluateOpenTargetsAfterObservation(
  book: ObservedBook,
): Promise<void> {
  const market = marketSnapshotFromObservedBook({
    levels: book.levels,
    minBuyCreditAtoms: book.minBuyCreditAtoms,
    reportedTotalCreditAtoms: book.reportedTotalCreditAtoms,
  });
  const open = await readOpenTargets();
  if (open.length === 0) return;

  const deadline = Date.now() + OBSERVATION_QUOTE_BUDGET_MS;
  let quotes = 0;

  for (const target of open) {
    const remaining = deadline - Date.now();
    const canQuote = quotes < OBSERVATION_QUOTE_CAP && remaining > 500;
    await evaluateAndPersistTarget(
      target,
      market,
      canQuote
        ? async (requestedCredit) => {
            quotes += 1;
            return quoteTargetTerms(requestedCredit);
          }
        : undefined,
    );
  }
}

export async function evaluateOwnedTargetLive(
  target: ProcurementTarget,
): Promise<ProcurementTarget | null> {
  const market = await readMarketSnapshot();
  return evaluateAndPersistTarget(target, market, quoteTargetTerms);
}
