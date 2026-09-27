import { readFileSync } from "node:fs";
import type { DecisionRecord, MarketSnapshot } from "../../types/ora";
import { decide, decideWithExecutableQuote, DEFAULT_PARAMS } from "../ora/decision";
import { historyDetail, reasonCopy } from "../ora/history-detail";
import { recordFromDecision } from "../ora/record";
import { patchToRow, recordToRow, rowToRecord } from "./rows";

function assert(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}

function value(rows: { label: string; value: string }[], label: string) {
  return rows.find((row) => row.label === label)?.value;
}

const wallet = "0x63fc81ed1e1eab3e2906b578ccd3097970852a1b";

function bookAt(discount: number): MarketSnapshot {
  return {
    timestamp: "2026-09-24T12:00:00.000Z",
    creditPrice: Number((1 - discount / 100).toFixed(6)),
    discountPercent: discount,
    bestDiscount: discount,
    availableAtBestDiscount: 80,
    depth: [{ discountPercent: discount, availableCredit: 80 }],
    source: "orbio",
    totalAvailableCredit: 80,
    minBuyCredit: 5,
  };
}

// WAIT persistence and detail: criteria come from this decision.
const wait = decide(bookAt(12), { ...DEFAULT_PARAMS, minDiscountPercent: 20, requestedCredit: 1 });
assert(wait.action === "WAIT" && wait.requestedAmount == null, "WAIT rule unchanged");
const waitRecord = rowToRecord(
  recordToRow(
    recordFromDecision(wait, {
      id: "wait-1",
      walletAddress: wallet,
      executionStatus: "none",
      reasoning: {
        recommendation: "WAIT",
        rationale: "Depth at 12% is well short of the 20% floor.",
        risks: [],
        agreesWithRule: true,
      },
      creditAcquired: 999,
      totalUsdgPaid: 1,
      txHash: "0xclient",
    }),
  ),
);
assert(waitRecord.minDiscountPercent === 20, "WAIT persists its minimum discount");
assert(waitRecord.evaluatedRequestedCredit === 5, "WAIT persists the evaluated CREDIT size");
assert(waitRecord.requestedAmount == null, "WAIT does not invent a BUY amount");
assert(waitRecord.walletAddress === wallet, "WAIT persists the wallet");
assert(waitRecord.txHash == null && waitRecord.creditAcquired == null, "decision insert ignores client fill data");
assert(waitRecord.totalUsdgPaid == null, "decision insert ignores client USDG paid");

const waitView = historyDetail(waitRecord);
assert(waitView.action === "WAIT", "WAIT detail shows the decision");
assert(waitView.discountObserved === "12%", "WAIT detail shows the observed discount");
assert(waitView.creditRequested === "5 CREDIT", "WAIT detail shows the evaluated CREDIT");
assert(waitView.status === "Decision", "WAIT detail shows its status");
assert(value(waitView.criteria, "Minimum discount") === "20%", "WAIT detail shows its own minimum");
assert(value(waitView.criteria, "CREDIT requested") == null, "criteria do not repeat CREDIT requested");
assert(value(waitView.criteria, "Spending limit") == null, "WAIT on the book does not show the spending limit");
assert(waitView.reason === "12% discount is below your 20% minimum, so Ora waits.", "WAIT reason uses the stored values");
assert(waitView.disagreement == null, "agreeing reasoning is not repeated under the reason");
assert(waitView.outcome.kind === "wait" && waitView.outcome.headline === "No purchase made.", "WAIT outcome is concise");
assert(waitView.outcome.quote.length === 0 && waitView.outcome.purchase.length === 0, "WAIT invents no quote or purchase");
assert(waitView.outcome.txHash == null, "WAIT shows no transaction");

// Reason copy keeps the stored numbers and drops the quote sentence.
assert(
  reasonCopy("30% discount meets your 20% threshold and enough CREDIT is available to fulfill your 5 CREDIT request. Executable quote is 28.6% at 3.57 USDG.") ===
    "30% discount meets your 20% minimum, and there is enough CREDIT available to fulfill your 5 CREDIT request.",
  "BUY reason separates the executable quote",
);
assert(
  reasonCopy("Best available discount is 30%, below your 40% threshold.") === "30% discount is below your 40% minimum, so Ora waits.",
  "WAIT reason uses the stored minimum",
);
assert(
  reasonCopy("Best available discount is 22%, below your 25% threshold.") === "22% discount is below your 25% minimum, so Ora waits.",
  "reason copy is not hard-coded",
);
assert(
  reasonCopy("32.5% discount meets your 18% threshold, but only 3.35 CREDIT is available at that level. You requested 7 CREDIT.") ===
    "32.5% discount meets your 18% minimum, but only 3.35 CREDIT is available at that level. You requested 7 CREDIT.",
  "thin-depth WAIT keeps its stored numbers",
);
assert(
  reasonCopy("Executable cost is 30 USDG, above your 25 USDG spending limit.") === "Executable cost is 30 USDG, above your 25 USDG spending limit.",
  "unknown reason text is shown as stored",
);

const disagreeing = historyDetail({
  ...waitRecord,
  reasoning: { recommendation: "BUY", rationale: "Depth may improve soon.", risks: [], agreesWithRule: false },
});
assert(disagreeing.disagreement?.rationale === "Depth may improve soon.", "disagreeing rationale is shown");

// The same logic at different criteria shows those criteria, not a constant.
const wait25 = recordFromDecision(
  decide(bookAt(22), { ...DEFAULT_PARAMS, minDiscountPercent: 25 }),
  { walletAddress: wallet },
);
const wait25View = historyDetail(rowToRecord(recordToRow(wait25)));
assert(value(wait25View.criteria, "Minimum discount") === "25%", "detail uses the 25% minimum");
assert(wait25View.discountObserved === "22%", "detail uses the 22% observation");
assert(wait25View.reason === "22% discount is below your 25% minimum, so Ora waits.", "reason uses the 25% minimum");

// Later settings do not change an old record.
const currentSettings = { ...DEFAULT_PARAMS, minDiscountPercent: 5 };
void currentSettings;
assert(value(historyDetail(waitRecord).criteria, "Minimum discount") === "20%", "old record keeps its own minimum");
assert(!("min_discount_percent" in patchToRow({ minDiscountPercent: 5 })), "criteria cannot be patched later");
assert(!("evaluated_requested_credit" in patchToRow({ evaluatedRequestedCredit: 50 })), "evaluated CREDIT cannot be patched later");

// BUY before execution.
const buy = decideWithExecutableQuote(bookAt(25), DEFAULT_PARAMS, {
  totalUsdg: 3.825,
  discountPercent: 23.5,
  creditOut: 5,
  requestedCredit: 5,
});
assert(buy.action === "BUY", "BUY rule unchanged");
const buyRow = recordToRow(
  recordFromDecision(buy, {
    id: "buy-1",
    walletAddress: wallet,
    executionStatus: "none",
    creditAcquired: 999,
    totalUsdgPaid: 0.01,
    executionPrice: 0.01,
    txHash: `0x${"11".repeat(32)}`,
    quotePrice: 0.01,
  }),
);
const buyRecord = rowToRecord(buyRow);
assert(buyRow.min_discount_percent === 20 && buyRow.requested_amount === 5, "BUY persists its criteria");
assert(buyRow.evaluated_requested_credit == null, "BUY does not duplicate requested_amount");
assert(buyRow.tx_hash == null && buyRow.credit_acquired == null, "BUY insert ignores client fill data");
assert(buyRow.total_usdg_paid == null && buyRow.execution_price == null, "BUY insert ignores client price data");
assert(buyRow.quote_price == null, "BUY insert ignores a client quote price");

const buyView = historyDetail(buyRecord);
assert(buyView.creditRequested === "5 CREDIT", "BUY shows CREDIT requested");
assert(value(buyView.criteria, "CREDIT requested") == null, "CREDIT requested is not repeated");
assert(value(buyView.criteria, "Minimum discount") === "20%", "BUY shows its minimum");
assert(value(buyView.criteria, "Spending limit") === "25 USDG", "BUY shows its spending limit");
assert(!buyView.reason.includes("Executable"), "BUY reason carries no quote information");
assert(value(buyView.outcome.quote, "Executable discount") === "23.5%", "BUY outcome shows the decision quote discount");
assert(buyView.outcome.kind === "none" && buyView.outcome.headline === "No purchase completed.", "unexecuted BUY shows no completed purchase");
assert(buyView.outcome.purchase.length === 0 && buyView.outcome.reason == null, "unexecuted BUY shows no empty fields");

// Review quote replaces the decision quote once the server has quoted.
const reviewed = rowToRecord({
  ...buyRow,
  ...patchToRow({ executionStatus: "review", quotePrice: 0.75, quotedUsdg: 3.75 }),
});
assert(value(historyDetail(reviewed).outcome.quote, "Executable discount") === "25%", "review quote discount derives from the quote price");
assert(historyDetail(reviewed).outcome.kind === "none", "reviewed BUY has no purchase");
assert(historyDetail(reviewed).status === "Review", "reviewed BUY shows its status");

// Blocked before signing.
const stale = rowToRecord({
  ...buyRow,
  ...patchToRow({ executionStatus: "stale_quote", blockedReason: "Quote expired before confirmation." }),
});
const staleView = historyDetail(stale);
assert(staleView.outcome.kind === "none", "stale BUY is not a purchase");
assert(staleView.outcome.reason === "Quote expired before confirmation.", "stale BUY shows its stored reason");

// Pending.
const pending = patchToRow({ txHash: `0x${"ab".repeat(32)}`, executionStatus: "pending" });
assert(!("credit_acquired" in pending) && !("total_usdg_paid" in pending), "pending writes no fill");
const pendingView = historyDetail(rowToRecord({ ...buyRow, ...pending }));
assert(pendingView.outcome.kind === "pending", "pending BUY shows pending");

// Confirmed from the receipt route's verified values.
const confirmed = rowToRecord({
  ...buyRow,
  ...patchToRow({
    txHash: `0x${"cd".repeat(32)}`,
    executionStatus: "success",
    creditAcquired: 5,
    totalUsdgPaid: 3.8,
    executionPrice: 0.76,
    confirmedAt: "2026-09-24T12:05:00.000Z",
  }),
});
const confirmedView = historyDetail(confirmed);
assert(confirmedView.outcome.kind === "confirmed", "confirmed BUY shows confirmed");
assert(confirmedView.status === "Confirmed", "confirmed BUY status");
assert(value(confirmedView.outcome.purchase, "CREDIT acquired") === "5 CREDIT", "confirmed shows CREDIT acquired");
assert(value(confirmedView.outcome.purchase, "USDG paid") === "3.8 USDG", "confirmed shows USDG paid");
assert(value(confirmedView.outcome.purchase, "Execution price") === "0.76 USDG per CREDIT", "confirmed shows execution price");
assert(value(confirmedView.outcome.quote, "Executable discount") === "23.5%", "confirmed shows the executable discount");
assert(confirmedView.outcome.txHash === `0x${"cd".repeat(32)}`, "confirmed links the transaction");

// Failed onchain.
const failed = rowToRecord({
  ...buyRow,
  ...patchToRow({
    txHash: `0x${"ef".repeat(32)}`,
    executionStatus: "failed",
    blockedReason: "Transaction reverted or failed.",
  }),
});
const failedView = historyDetail(failed);
assert(failedView.outcome.kind === "failed", "failed BUY shows failed");
assert(failedView.outcome.reason === "Transaction reverted or failed.", "failed shows its reason");
assert(failedView.outcome.purchase.length === 0, "failed BUY shows no fill amounts");

// Old rows recorded before the migration.
const legacy: DecisionRecord = {
  id: "legacy",
  timestamp: "2026-09-20T12:00:00.000Z",
  market: { price: 0.8, discountPercent: 20, availableDepth: 3 },
  snapshot: bookAt(20),
  decision: "WAIT",
  reason: "20% discount meets your 20% threshold, but only 3 CREDIT is available at that level. You requested 5 CREDIT.",
};
const legacyView = historyDetail(rowToRecord(recordToRow({ ...legacy, walletAddress: wallet })));
assert(legacyView.criteria.length === 0, "legacy WAIT omits criteria it never stored");
assert(legacyView.creditRequested == null, "legacy WAIT omits CREDIT requested");
assert(legacyView.disagreement == null && legacyView.outcome.kind === "wait", "legacy WAIT renders without reasoning or purchase");
assert(legacyView.reason === "20% discount meets your 20% minimum, but only 3 CREDIT is available at that level. You requested 5 CREDIT.", "legacy reason keeps stored numbers");
const legacyBuy = historyDetail({ ...legacy, decision: "BUY", requestedAmount: 5, executionStatus: "failed", blockedReason: "Transaction rejected in the wallet. No purchase was sent." });
assert(legacyBuy.outcome.kind === "none", "wallet-rejected BUY without a hash is not a purchase");
assert(value(legacyBuy.criteria, "Minimum discount") == null, "legacy BUY omits unknown minimum");

// Authoritative write paths.
const src = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const decisionSource = src("../../app/api/decision/route.ts");
const confirmSource = src("../../app/api/execute/confirm/route.ts");
const receiptSource = src("../../app/api/execute/receipt/route.ts");
const abortSource = src("../../app/api/execute/abort/route.ts");
const ledgerSource = src("../../app/api/ledger/route.ts");
assert(!decisionSource.includes("creditAcquired") && !decisionSource.includes("totalUsdgPaid"), "decision route takes no fill amounts");
assert(!confirmSource.includes("creditAcquired") && !confirmSource.includes("totalUsdgPaid"), "pending confirm takes no fill amounts");
assert(receiptSource.includes("creditAcquired: execution.creditAcquired"), "receipt stores chain CREDIT");
assert(receiptSource.includes("totalUsdgPaid: execution.totalUsdgPaid"), "receipt stores chain USDG");
assert(!receiptSource.includes("body.creditAcquired") && !receiptSource.includes("body.totalUsdgPaid"), "receipt ignores client amounts");
assert(!abortSource.includes("creditAcquired") && !abortSource.includes("txHash"), "abort cannot write a fill or hash");
for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
  assert(!ledgerSource.includes(`export async function ${method}`), `ledger stays read-only (${method})`);
}

console.log("history audit persistence ok");
