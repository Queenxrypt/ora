"use client";

import { useEffect, useState } from "react";
import type { MarketSnapshot, ProcurementTarget, UserSettings } from "../types/ora";
import { TARGET_STATUS_COPY } from "../lib/ora/target";
import { formatCredit, formatPrice } from "../lib/ora/format";
import { TelegramAlerts } from "./TelegramAlerts";

type Draft = {
  requestedCredit: number;
  minDiscountPercent: number;
  maxSpendUsdg: number;
};

export function ProcurementTargetPanel({
  connected,
  settings,
  market,
  target,
  error,
  busy,
  fulfilledCredit,
  fulfilledUsdg,
  onCreate,
  onCancel,
  onReview,
}: {
  connected: boolean;
  settings: UserSettings | null;
  market: MarketSnapshot | null;
  target: ProcurementTarget | null;
  error: string | null;
  busy: boolean;
  fulfilledCredit?: number;
  fulfilledUsdg?: number;
  onCreate: (draft: Draft) => Promise<void>;
  onCancel: () => Promise<void>;
  onReview: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<Draft>({
    requestedCredit: settings?.requestedCredit ?? 50,
    minDiscountPercent: settings?.minDiscountPercent ?? 20,
    maxSpendUsdg: settings?.spendingLimitUsdg ?? 40,
  });
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (target && target.status !== "FULFILLED") {
      setCreating(false);
    }
    if (target) return;
    if (!settings) return;
    setDraft({
      requestedCredit: settings.requestedCredit,
      minDiscountPercent: settings.minDiscountPercent,
      maxSpendUsdg: settings.spendingLimitUsdg,
    });
  }, [settings, target]);

  const showCreate =
    !target || target.status === "CANCELLED" || creating;
  const showFulfilled = target?.status === "FULFILLED" && !creating;

  return (
    <section className="panel settings-panel target-panel" id="targets">
      <h2>{showCreate && !showFulfilled ? "Procurement targets" : "Procurement target"}</h2>
      {!connected && (
        <p className="status">
          Wallet disconnected. Connect from the top bar before confirming a purchase.
        </p>
      )}
      {error && <p className="error">{error}</p>}

      {showFulfilled && target && (
        <TargetComplete
          target={target}
          creditAcquired={fulfilledCredit}
          usdgPaid={fulfilledUsdg}
          onNew={() => setCreating(true)}
        />
      )}

      {target && (target.status === "WATCHING" || target.status === "READY") && (
        <OpenTarget
          target={target}
          busy={busy}
          onCancel={onCancel}
          onReview={onReview}
        />
      )}

      {showCreate && (
        <>
          <p className="status">Tell Ora what you want to acquire.</p>
          <form
            className="settings-form"
            onSubmit={(event) => {
              event.preventDefault();
              void onCreate(draft);
            }}
          >
            <fieldset className="settings-group">
              <legend>Target</legend>
              <div className="fields">
                <label>
                  CREDIT
                  <input
                    type="number"
                    min={market?.minBuyCredit ?? 5}
                    step="1"
                    value={draft.requestedCredit}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        requestedCredit: Number(e.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  MIN DISCOUNT
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step="1"
                    value={draft.minDiscountPercent}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        minDiscountPercent: Number(e.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  MAX SPEND
                  <input
                    type="number"
                    min={1}
                    step="1"
                    value={draft.maxSpendUsdg}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        maxSpendUsdg: Number(e.target.value),
                      })
                    }
                  />
                </label>
              </div>
            </fieldset>
            <button className="btn secondary" type="submit" disabled={busy || !connected}>
              {busy ? "Setting…" : "Set target"}
            </button>
          </form>
        </>
      )}

      {connected && <TelegramAlerts />}
    </section>
  );
}

function OpenTarget({
  target,
  busy,
  onCancel,
  onReview,
}: {
  target: ProcurementTarget;
  busy: boolean;
  onCancel: () => Promise<void>;
  onReview: () => Promise<void>;
}) {
  const copy = TARGET_STATUS_COPY[target.status === "READY" ? "READY" : "WATCHING"];
  const ready = target.status === "READY";
  return (
    <div className="target-body">
      <p className="decision-amount mono">
        {formatCredit(target.requestedCredit)} CREDIT
      </p>
      <p className="status">
        Minimum discount {target.minDiscountPercent}%
        {" · "}
        Maximum spend {formatPrice(target.maxSpendUsdg)} USDG
      </p>
      <p className={`command-readiness ${ready ? "buy" : "wait"}`}>
        {copy.label}
      </p>
      <p className="status">{copy.detail}</p>
      {ready && (
        <div className="procurement-check">
          <div className="procurement-rows">
            <div className="procurement-row">
              <span className="procurement-label">Executable discount</span>
              <span className="procurement-leader" aria-hidden="true" />
              <span className="procurement-value mono">
                {target.lastExecutableDiscountPercent != null
                  ? `${target.lastExecutableDiscountPercent}%`
                  : "—"}
              </span>
            </div>
            <div className="procurement-row">
              <span className="procurement-label">Executable quote</span>
              <span className="procurement-leader" aria-hidden="true" />
              <span className="procurement-value mono">
                {target.lastExecutableTotalUsdg != null
                  ? `${formatPrice(target.lastExecutableTotalUsdg)} USDG`
                  : "—"}
              </span>
            </div>
          </div>
        </div>
      )}
      <div className="command-actions target-actions">
        {ready && (
          <button
            className="btn btn-action command-cta command-review"
            type="button"
            disabled={busy}
            onClick={() => void onReview()}
          >
            {busy ? "Checking…" : "Review purchase"}
          </button>
        )}
        <button
          className="btn secondary"
          type="button"
          disabled={busy}
          onClick={() => void onCancel()}
        >
          Cancel target
        </button>
      </div>
    </div>
  );
}

function TargetComplete({
  target,
  creditAcquired,
  usdgPaid,
  onNew,
}: {
  target: ProcurementTarget;
  creditAcquired?: number;
  usdgPaid?: number;
  onNew: () => void;
}) {
  const copy = TARGET_STATUS_COPY.FULFILLED;
  const acquired = creditAcquired ?? target.lastRequestedAmount ?? target.requestedCredit;
  return (
    <div className="target-body">
      <p className="decision-amount mono">
        {formatCredit(target.requestedCredit)} CREDIT
      </p>
      <p className="command-readiness buy">{copy.label}</p>
      <p className="status success-copy">
        {formatCredit(acquired)} CREDIT acquired
      </p>
      {usdgPaid != null && (
        <p className="status success-copy">
          {formatPrice(usdgPaid)} USDG paid
        </p>
      )}
      <p className="status">{copy.detail}</p>
      <div className="command-actions target-actions">
        <button className="btn secondary" type="button" onClick={onNew}>
          Set a new target
        </button>
      </div>
    </div>
  );
}
