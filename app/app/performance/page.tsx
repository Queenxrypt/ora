"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type {
  DecisionOutcome,
  PerformanceSummary,
} from "../../../types/ora";
import { formatCredit, formatPrice, recordStage } from "../../../lib/ora/format";
import { walletSearchParam } from "../../../lib/ora/wallet";
import { useWallet } from "../../../lib/wallet/wallet";

function executionStage(
  outcome: DecisionOutcome,
): "Confirmed" | "Pending" | "Failed" | null {
  if (outcome.kind !== "BUY") return null;
  const stage = recordStage(outcome.executionStatus, "BUY");
  if (stage === "Confirmed" || stage === "Pending" || stage === "Failed") {
    return stage;
  }
  return null;
}

export default function PerformancePage() {
  const { address } = useWallet();
  const [performance, setPerformance] = useState<PerformanceSummary | null>(
    null,
  );
  const [outcomes, setOutcomes] = useState<DecisionOutcome[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetch(`/api/performance${walletSearchParam(address)}`, { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? "Unavailable");
        setPerformance(data.performance ?? null);
        setOutcomes(data.outcomes ?? []);
      })
      .catch((err: Error) => setError(err.message));
  }, [address]);

  const confirmedPurchases = performance?.successfulExecutions ?? 0;
  const hasDecisionActivity =
    (performance?.buyCount ?? 0) + (performance?.waitCount ?? 0) > 0;

  const executionCounts = useMemo(() => {
    let pending = 0;
    let failed = 0;
    for (const outcome of outcomes) {
      const stage = executionStage(outcome);
      if (stage === "Pending") pending += 1;
      if (stage === "Failed") failed += 1;
    }
    return { pending, failed };
  }, [outcomes]);

  const measuredOutcomes = useMemo(
    () =>
      outcomes.filter(
        (item) =>
          item.kind === "BUY" && item.resolved && item.phase === "outcome",
      ),
    [outcomes],
  );

  const view =
    confirmedPurchases === 0
      ? "empty"
      : measuredOutcomes.length === 0
        ? "awaiting"
        : "measured";

  const showExecutionCounts =
    view !== "empty" &&
    (executionCounts.pending > 0 || executionCounts.failed > 0);

  return (
    <main className="desk">
      <section className="panel performance-panel">
        <h2>Performance</h2>
        {error && <p className="error">{error}</p>}
        {!performance && !error && (
          <p className="status performance-empty">Loading performance…</p>
        )}
        {performance && (
          <>
            <p className="status performance-intro">
              Measure whether Ora&apos;s procurement decisions lead to better
              CREDIT acquisition outcomes.
            </p>

            {view === "empty" && (
              <div className="performance-focus">
                <h3 className="performance-focus-title">
                  No measured performance yet
                </h3>
                <p className="status">
                  You haven&apos;t completed a CREDIT purchase yet.
                </p>
                <p className="status">
                  Performance will appear after a purchase is confirmed and a
                  later market snapshot is available.
                </p>
              </div>
            )}

            {view === "awaiting" && (
              <div className="report-block">
                <h3>Awaiting measurement</h3>
                <p className="status">
                  Purchase confirmed. Performance measurement will appear after
                  a later market snapshot is available.
                </p>
                <div className="row">
                  <span className="label">Confirmed purchases</span>
                  <span className="value">{confirmedPurchases}</span>
                </div>
              </div>
            )}

            {view === "measured" && (
              <div className="report-block">
                <h3>Measured outcomes</h3>
                <div className="row">
                  <span className="label">Measured outcomes</span>
                  <span className="value">{measuredOutcomes.length}</span>
                </div>
                <div className="row">
                  <span className="label">Confirmed purchases</span>
                  <span className="value">{confirmedPurchases}</span>
                </div>
                <div className="row">
                  <span className="label">CREDIT purchased</span>
                  <span className="value">
                    {formatCredit(performance.totalCreditPurchased)}
                  </span>
                </div>
                <div className="row">
                  <span className="label">Total procurement cost</span>
                  <span className="value">
                    {formatPrice(performance.totalProcurementCost)} USDG
                  </span>
                </div>
                {performance.averageEffectivePrice != null && (
                  <div className="row">
                    <span className="label">Average effective price</span>
                    <span className="value">
                      {formatPrice(performance.averageEffectivePrice)} USDG
                    </span>
                  </div>
                )}
                {performance.comparableBuyOnDemandCost != null && (
                  <div className="row">
                    <span className="label">Later buy-on-demand cost</span>
                    <span className="value">
                      {formatPrice(performance.comparableBuyOnDemandCost)} USDG
                    </span>
                  </div>
                )}
                {performance.difference != null && (
                  <div className="row">
                    <span className="label">Difference vs Ora</span>
                    <span className="value">
                      {formatPrice(performance.difference)} USDG
                    </span>
                  </div>
                )}
              </div>
            )}

            {(view === "empty" || hasDecisionActivity) && (
              <div className="performance-activity">
                <h3>Activity</h3>
                <div className="performance-metrics">
                  <div className="performance-metric">
                    <span className="performance-metric-label">BUY</span>
                    <span
                      className={
                        performance.buyCount > 0
                          ? "performance-metric-value is-buy"
                          : "performance-metric-value"
                      }
                    >
                      {performance.buyCount}
                    </span>
                  </div>
                  <div className="performance-metric">
                    <span className="performance-metric-label">WAIT</span>
                    <span className="performance-metric-value">
                      {performance.waitCount}
                    </span>
                  </div>
                  <div className="performance-metric">
                    <span className="performance-metric-label">Confirmed</span>
                    <span
                      className={
                        confirmedPurchases > 0
                          ? "performance-metric-value is-confirmed"
                          : "performance-metric-value"
                      }
                    >
                      {confirmedPurchases}
                    </span>
                  </div>
                </div>
              </div>
            )}

            {showExecutionCounts && (
              <div className="report-block">
                <h3>Execution</h3>
                {executionCounts.pending > 0 && (
                  <div className="row">
                    <span className="label">Pending</span>
                    <span className="value">{executionCounts.pending}</span>
                  </div>
                )}
                {executionCounts.failed > 0 && (
                  <div className="row">
                    <span className="label">Failed</span>
                    <span className="value">{executionCounts.failed}</span>
                  </div>
                )}
              </div>
            )}

            <div className="performance-cta">
              <Link href="/app/history" className="btn secondary">
                View decision history →
              </Link>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
