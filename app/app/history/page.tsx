"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { DecisionRecord } from "../../../types/ora";
import {
  formatTime,
  recordStage,
  recordStageClass,
} from "../../../lib/ora/format";
import { walletSearchParam } from "../../../lib/ora/wallet";
import { useWallet } from "../../../lib/wallet/wallet";

export default function HistoryPage() {
  const { address } = useWallet();
  const [history, setHistory] = useState<DecisionRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    void fetch(`/api/ledger${walletSearchParam(address)}`, { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? "Ledger unavailable");
        setHistory(data.decisions ?? []);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [address]);

  return (
    <main className="desk">
      <section className="panel history-panel">
        <h2>History</h2>
        <h3 className="history-heading">Your procurement activity</h3>
        <p className="status history-intro">
          History records Ora&apos;s BUY and WAIT decisions and tracks their
          execution status.
        </p>
        {error && <p className="error">{error}</p>}
        {loading && !error && (
          <p className="status is-loading">Loading ledger…</p>
        )}
        {!loading && history.length === 0 && !error && (
          <div className="history-empty">
            <h3 className="history-empty-title">No decisions yet</h3>
            <p className="status">
              Ora hasn&apos;t recorded a procurement decision yet.
            </p>
            <p className="status">
              Your decisions will appear here once you start using the Market
              desk.
            </p>
            <Link href="/app/market" className="btn secondary">
              Open Market →
            </Link>
          </div>
        )}
        {history.length > 0 && (
          <>
          <div className="status-guide">
            <h3 className="status-guide-title">Status guide</h3>
            <ul className="status-guide-list">
              <li>
                <span className="status-guide-label">Decision</span>
                <span className="status-guide-sep" aria-hidden="true">
                  ·
                </span>
                <span className="status-guide-copy">
                  Ora recorded a BUY/WAIT decision
                </span>
              </li>
              <li>
                <span className="status-guide-label">Review</span>
                <span className="status-guide-sep" aria-hidden="true">
                  ·
                </span>
                <span className="status-guide-copy">
                  Ora decided BUY and is waiting for you to review the purchase
                </span>
              </li>
              <li>
                <span className="status-guide-label">Pending</span>
                <span className="status-guide-sep" aria-hidden="true">
                  ·
                </span>
                <span className="status-guide-copy">
                  Transaction submitted, awaiting confirmation
                </span>
              </li>
              <li>
                <span className="status-guide-label">Confirmed</span>
                <span className="status-guide-sep" aria-hidden="true">
                  ·
                </span>
                <span className="status-guide-copy">
                  Transaction confirmed onchain
                </span>
              </li>
              <li>
                <span className="status-guide-label">Failed</span>
                <span className="status-guide-sep" aria-hidden="true">
                  ·
                </span>
                <span className="status-guide-copy">
                  Execution did not complete
                </span>
              </li>
            </ul>
          </div>
          <div className="table-wrap">
          <table className="history">
            <thead>
              <tr>
                <th>Time</th>
                <th>Action</th>
                <th>Discount</th>
                <th>Amount</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {history.map((item) => (
                <tr key={item.id}>
                  <td>{formatTime(item.timestamp)}</td>
                  <td className={item.decision === "BUY" ? "action-buy" : "action-wait"}>
                    {item.decision}
                  </td>
                  <td className="mono">{item.market.discountPercent}%</td>
                  <td className="mono">{item.requestedAmount ?? "—"}</td>
                  <td>
                    <span
                      className={recordStageClass(
                        item.executionStatus,
                        item.decision,
                      )}
                    >
                      {recordStage(item.executionStatus, item.decision)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          </>
        )}
      </section>
    </main>
  );
}
