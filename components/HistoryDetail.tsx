import type { DecisionRecord } from "../types/ora";
import { historyDetail, type DetailRow } from "../lib/ora/history-detail";
import {
  afterMarketView,
  type MarketOutcome,
} from "../lib/ora/outcome-engine";
import { robinhoodChain } from "../lib/orbio/exchange";

function Rows({ rows }: { rows: DetailRow[] }) {
  return (
    <dl className="hd-rows">
      {rows.map((row) => (
        <div className="hd-row" key={row.label}>
          <dt>{row.label}</dt>
          <dd>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export default function HistoryDetail({
  record,
  after,
  afterLoading = false,
  afterError = null,
  onClose,
}: {
  record: DecisionRecord;
  after?: MarketOutcome | null;
  afterLoading?: boolean;
  afterError?: string | null;
  onClose: () => void;
}) {
  const view = historyDetail(record);
  const { outcome } = view;
  const explorer = robinhoodChain.blockExplorers.default.url;
  const afterView = after ? afterMarketView(after) : null;

  return (
    <div className="detail hd">
      <div className="hd-bar">
        <button type="button" className="hd-close" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="hd-grid">
        <section className="hd-card hd-decision">
          <p className="hd-eyebrow">Decision</p>
          <p className={`hd-action is-${view.action.toLowerCase()}`}>{view.action}</p>
          <p className="hd-figure">{view.discountObserved}</p>
          <p className="hd-figure-label">Discount observed</p>
          <Rows
            rows={[
              ...(view.creditRequested
                ? [{ label: "CREDIT requested", value: view.creditRequested }]
                : []),
              { label: "Status", value: view.status },
            ]}
          />
        </section>

        <section className="hd-card">
          <p className="hd-eyebrow">Ora&apos;s reason</p>
          <p className="hd-reason">{view.reason}</p>
          {view.disagreement && (
            <p className="hd-note">
              Ora&apos;s reasoning recommended {view.disagreement.recommendation}:{" "}
              {view.disagreement.rationale}
            </p>
          )}
          {view.criteria.length > 0 && (
            <div className="hd-block">
              <p className="hd-eyebrow">Criteria</p>
              <Rows rows={view.criteria} />
            </div>
          )}
        </section>

        <section className="hd-card">
          <p className="hd-eyebrow">Outcome</p>
          <p className={`hd-outcome is-${outcome.kind}`}>{outcome.headline}</p>
          {outcome.reason && <p className="hd-note">{outcome.reason}</p>}
          {outcome.quote.length > 0 && (
            <div className="hd-block">
              <p className="hd-eyebrow">Executable quote</p>
              <Rows rows={outcome.quote} />
            </div>
          )}
          {(outcome.purchase.length > 0 || outcome.txHash) && (
            <div className="hd-block">
              <p className="hd-eyebrow">Purchase</p>
              {outcome.purchase.length > 0 && <Rows rows={outcome.purchase} />}
              {outcome.txHash && (
                <a
                  className="hd-tx"
                  href={`${explorer}/tx/${outcome.txHash}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {`${outcome.txHash.slice(0, 10)}…${outcome.txHash.slice(-8)}`} ↗
                </a>
              )}
            </div>
          )}
        </section>

        {(afterLoading || afterError || afterView) && (
          <section className="hd-card hd-after">
            <p className="hd-eyebrow">What happened after</p>
            {afterLoading && (
              <p className="status is-loading">Loading later observations…</p>
            )}
            {afterError && <p className="error">{afterError}</p>}
            {!afterLoading && !afterError && afterView && (
              <>
                <p className="hd-outcome">{afterView.headline}</p>
                {afterView.note && <p className="hd-note">{afterView.note}</p>}
                {afterView.rows.length > 0 && <Rows rows={afterView.rows} />}
              </>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
