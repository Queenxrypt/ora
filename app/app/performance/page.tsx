"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatCredit, formatPrice, formatTime } from "../../../lib/ora/format";
import type { PerformanceReport } from "../../../lib/ora/performance";
import { walletSearchParam } from "../../../lib/ora/wallet";
import { useWallet } from "../../../lib/wallet/wallet";

export default function PerformancePage() {
  const { address } = useWallet();
  const [performance, setPerformance] = useState<PerformanceReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPerformance(null);
    setError(null);
    void fetch(`/api/performance${walletSearchParam(address)}`, { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? "Unavailable");
        setPerformance(data.performance ?? null);
      })
      .catch((err: Error) => setError(err.message));
  }, [address]);

  const showBuilding =
    performance != null && (!performance.hasDecisions || !performance.hasEvidence);
  const showStory = performance != null && performance.hasEvidence;

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
              Confirmed purchases, decisions, and what happened afterward.
            </p>

            {showBuilding && (
              <div className="performance-focus">
                <h3 className="performance-focus-title">
                  Performance data is still building
                </h3>
                <p className="status">
                  Ora needs more confirmed procurement decisions and completed
                  outcome windows before a meaningful comparison can be shown.
                </p>
              </div>
            )}

            {showStory && performance.procurement && (
              <div className="performance-section">
                <h3>Procurement</h3>
                <div className="row">
                  <span className="label">CREDIT purchased</span>
                  <span className="value">
                    {formatCredit(performance.procurement.creditPurchased)}
                  </span>
                </div>
                <div className="row">
                  <span className="label">USDG spent</span>
                  <span className="value">
                    {formatPrice(performance.procurement.usdgSpent)} USDG
                  </span>
                </div>
                {performance.procurement.averageExecutionPrice != null && (
                  <div className="row">
                    <span className="label">Average execution price</span>
                    <span className="value">
                      {formatPrice(performance.procurement.averageExecutionPrice)}{" "}
                      USDG
                    </span>
                  </div>
                )}
                {performance.procurement.averageExecutionDiscount != null && (
                  <div className="row">
                    <span className="label">Average execution discount</span>
                    <span className="value">
                      {performance.procurement.averageExecutionDiscount}%
                    </span>
                  </div>
                )}
                <div className="row">
                  <span className="label">Confirmed purchases</span>
                  <span className="value">
                    {performance.procurement.confirmedPurchases}
                  </span>
                </div>
              </div>
            )}

            {performance.hasDecisions && (
              <div className="performance-section">
                <h3>Decisions</h3>
                <div className="row">
                  <span className="label">BUY</span>
                  <span className="value">{performance.decisions.buyCount}</span>
                </div>
                <div className="row">
                  <span className="label">WAIT</span>
                  <span className="value">{performance.decisions.waitCount}</span>
                </div>
                <div className="row">
                  <span className="label">Total decisions</span>
                  <span className="value">{performance.decisions.total}</span>
                </div>
                <div className="row">
                  <span className="label">Completed outcome evaluations</span>
                  <span className="value">
                    {performance.decisions.completedOutcomes}
                  </span>
                </div>
                <div className="row">
                  <span className="label">Pending outcome evaluations</span>
                  <span className="value">
                    {performance.decisions.pendingOutcomes}
                  </span>
                </div>
              </div>
            )}

            {showStory && (
              <div className="performance-section">
                <h3>Outcomes</h3>
                <div className="row">
                  <span className="label">WAIT → qualifying opportunity observed</span>
                  <span className="value">{performance.outcomes.waitQualifying}</span>
                </div>
                <div className="row">
                  <span className="label">WAIT → no qualifying opportunity observed</span>
                  <span className="value">{performance.outcomes.waitNone}</span>
                </div>
                <div className="row">
                  <span className="label">BUY → better observed opportunity later</span>
                  <span className="value">{performance.outcomes.buyBetter}</span>
                </div>
                <div className="row">
                  <span className="label">BUY → no better observed opportunity later</span>
                  <span className="value">{performance.outcomes.buyNone}</span>
                </div>
                <div className="row">
                  <span className="label">Still being evaluated</span>
                  <span className="value">{performance.outcomes.pending}</span>
                </div>
              </div>
            )}

            {performance.hasDecisions && (
              <div className="performance-section">
                <h3>Comparison</h3>
                <p className="status">{performance.comparison.detail}</p>
              </div>
            )}

            {showStory && performance.history.length > 0 && (
              <div className="performance-section">
                <h3>After the decision</h3>
                <div className="table-wrap">
                  <table className="history">
                    <thead>
                      <tr>
                        <th>Time</th>
                        <th>Decision</th>
                        <th>Discount</th>
                        <th>Result</th>
                        <th>Later</th>
                      </tr>
                    </thead>
                    <tbody>
                      {performance.history.map((row, index) => (
                        <tr
                          className="history-row"
                          key={`${row.timestamp}-${row.action}-${index}`}
                        >
                          <td>{formatTime(row.timestamp)}</td>
                          <td
                            className={
                              row.action === "BUY" ? "action-buy" : "action-wait"
                            }
                          >
                            {row.action}
                          </td>
                          <td className="mono">{row.observedDiscountPercent}%</td>
                          <td>{row.status}</td>
                          <td className="mono">
                            {row.laterDiscountPercent != null
                              ? `${row.laterDiscountPercent}% · ${row.appearedAfter}`
                              : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
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
