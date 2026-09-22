import type {
  DecisionOutcome,
  DecisionRecord,
  PerformanceSummary,
} from "../../types/ora";
import { evaluateAll, isConfirmedBuy, isLaterSnapshot } from "./outcomes";
import { buyOnDemandCost } from "./baseline";
import { performanceFrom } from "../db/store";
import type { MarketSnapshot } from "../../types/ora";

export function summarizePerformance(
  decisions: DecisionRecord[],
  latest: MarketSnapshot | null,
  outcomes: DecisionOutcome[] = evaluateAll(decisions, latest),
): PerformanceSummary {
  const base = performanceFrom(decisions);
  const unresolvedCount = outcomes.filter((item) => !item.resolved).length;
  const executed = decisions.filter(isConfirmedBuy);

  const comparableRecords =
    latest == null
      ? []
      : executed.filter((record) => isLaterSnapshot(record, latest));

  const canCompare =
    executed.length > 0 && comparableRecords.length === executed.length;

  let comparableBuyOnDemandCost: number | null = null;
  let difference: number | null = null;
  if (canCompare && latest) {
    const comparable = comparableRecords.reduce((sum, record) => {
      return sum + buyOnDemandCost(record.creditAcquired as number, latest);
    }, 0);
    comparableBuyOnDemandCost = Number(comparable.toFixed(6));
    difference = Number(
      (comparableBuyOnDemandCost - base.totalProcurementCost).toFixed(6),
    );
  }

  const enoughData = executed.length >= 3;
  const note =
    executed.length === 0
      ? "No confirmed CREDIT purchases yet. Decision counts below are a log, not a strategy score."
      : enoughData
        ? "Figures use confirmed fills only. They are a running comparison, not proof that Ora is a better strategy."
        : "Too few confirmed purchases to treat this as a strategy result. Confirmed fills are listed as a log, not a score.";

  return {
    ...base,
    comparableBuyOnDemandCost,
    difference,
    unresolvedCount,
    enoughData,
    note,
  };
}
