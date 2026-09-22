import type { DecisionRecord } from "../../types/ora";
import { patchToRow, recordToRow, rowToRecord } from "./rows";

const sample: DecisionRecord = {
  id: "dec-1",
  timestamp: "2026-09-21T10:00:00.000Z",
  market: { price: 0.775, discountPercent: 22.5, availableDepth: 6.5 },
  snapshot: {
    timestamp: "2026-09-21T10:00:00.000Z",
    creditPrice: 0.775,
    discountPercent: 22.5,
    bestDiscount: 22.5,
    availableAtBestDiscount: 6.5,
    depth: [{ discountPercent: 22.5, availableCredit: 6.5 }],
    source: "orbio",
    totalAvailableCredit: 100,
    minBuyCredit: 5,
  },
  decision: "BUY",
  reason: "Discount meets the threshold.",
  requestedAmount: 5,
  walletAddress: "0x63fc81ed1e1eab3e2906b578ccd3097970852a1b",
  executionStatus: "pending",
  txHash: "0xabc",
  reasoning: {
    recommendation: "WAIT",
    rationale: "Depth is thin.",
    risks: ["Fill may differ"],
    agreesWithRule: false,
  },
};

const row = recordToRow(sample);
if (row.wallet_address !== sample.walletAddress) {
  throw new Error("wallet_address must be persisted");
}
if (row.requested_amount !== 5) {
  throw new Error("requested_amount must round-trip");
}
if (!row.reasoning || row.reasoning.recommendation !== "WAIT") {
  throw new Error("reasoning must persist");
}

const back = rowToRecord(row);
if (back.decision !== "BUY" || back.walletAddress !== sample.walletAddress) {
  throw new Error("Record round-trip must preserve owner and decision");
}
if (back.reasoning?.agreesWithRule !== false) {
  throw new Error("Reasoning disagreement must persist");
}

const cleared = patchToRow({ blockedReason: undefined, executionStatus: "success" });
if (cleared.blocked_reason !== null) {
  throw new Error("Explicit undefined blockedReason must clear the column");
}
if (cleared.execution_status !== "success") {
  throw new Error("executionStatus patch must apply");
}

const ignoredWallet = patchToRow({
  walletAddress: "0x1111111111111111111111111111111111111111",
  txHash: "0xdef",
});
if ("wallet_address" in ignoredWallet) {
  throw new Error("Patch must not retarget wallet_address");
}

console.log("store row mapping ok");
