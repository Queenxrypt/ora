import { readFileSync } from "node:fs";
import { decide, DEFAULT_PARAMS } from "../ora/decision";
import { patchToRow } from "./rows";
import * as ledger from "../../app/api/ledger/route.ts";
import * as receipt from "../../app/api/execute/receipt/route.ts";
import type { MarketSnapshot } from "../../types/ora";

const routeSource = readFileSync(
  new URL("../../app/api/ledger/route.ts", import.meta.url),
  "utf8",
);
const receiptSource = readFileSync(
  new URL("../../app/api/execute/receipt/route.ts", import.meta.url),
  "utf8",
);

const CLIENT_WRITERS = ["POST", "PUT", "PATCH", "DELETE"] as const;
const wallet = "0x63fc81ed1e1eab3e2906b578ccd3097970852a1b";

function assertNoClientWriter(label: string) {
  for (const method of CLIENT_WRITERS) {
    if (typeof (ledger as Record<string, unknown>)[method] === "function") {
      throw new Error(`${label}: ${method} /api/ledger must not exist`);
    }
  }
  if (
    routeSource.includes("updateOwnedDecision") ||
    routeSource.includes("patchToRow") ||
    routeSource.includes(".update(")
  ) {
    throw new Error(`${label}: /api/ledger must not write decision rows`);
  }
}

async function assertRejected(
  label: string,
  patch: Record<string, unknown>,
) {
  assertNoClientWriter(label);
  const mutate = (ledger as { PATCH?: (request: Request) => Promise<Response> })
    .PATCH;
  if (typeof mutate !== "function") return;
  const response = await mutate(
    new Request("http://localhost/api/ledger", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "dec-confirmed",
        walletAddress: wallet,
        patch,
      }),
    }),
  );
  if (response.ok) {
    throw new Error(`${label}: client ledger mutation must be rejected`);
  }
  const body = (await response.json()) as { record?: unknown };
  if (body.record) {
    throw new Error(`${label}: rejected mutation must not return a record`);
  }
}

await assertRejected("A", { executionStatus: "success" });
await assertRejected("B", {
  txHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
});
await assertRejected("C", { creditAcquired: 999 });
await assertRejected("D", { totalUsdgPaid: 1 });
await assertRejected("E", { confirmedAt: "2026-09-23T00:00:00.000Z" });
await assertRejected("F", {
  executionStatus: "failed",
  blockedReason: "rewritten after confirmation",
  creditAcquired: 1,
  totalUsdgPaid: 1,
  executionPrice: 0.5,
  confirmedAt: null,
});

const verified = patchToRow({
  txHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  executionStatus: "success",
  creditAcquired: 5,
  totalUsdgPaid: 3.825,
  executionPrice: 0.765,
  confirmedAt: "2026-09-23T15:00:00.000Z",
});
if (verified.execution_status !== "success") {
  throw new Error("G: receipt success status must still map");
}
if (verified.tx_hash?.startsWith("0xbbbb") !== true) {
  throw new Error("G: receipt transaction hash must still map");
}
if (verified.credit_acquired !== 5 || verified.total_usdg_paid !== 3.825) {
  throw new Error("G: receipt financial amounts must still map");
}
if (verified.execution_price !== 0.765 || !verified.confirmed_at) {
  throw new Error("G: receipt price and confirmation time must still map");
}
if (typeof receipt.POST !== "function") {
  throw new Error("G: receipt verification route must remain");
}
if (!receiptSource.includes('executionStatus: "success"')) {
  throw new Error("G: receipt route must still record a verified confirmation");
}
if (
  !receiptSource.includes("creditAcquired:") ||
  !receiptSource.includes("totalUsdgPaid:") ||
  !receiptSource.includes("confirmedAt:")
) {
  throw new Error("G: receipt route must still store verified fill amounts");
}
if (receiptSource.includes('executionStatus === "success"') !== true) {
  throw new Error("G: an already confirmed receipt must return the stored record");
}

const book: MarketSnapshot = {
  timestamp: "2026-09-19T00:00:00.000Z",
  creditPrice: 0.75,
  discountPercent: 25,
  bestDiscount: 25,
  availableAtBestDiscount: 80,
  depth: [
    { discountPercent: 25, availableCredit: 80 },
    { discountPercent: 10, availableCredit: 100 },
  ],
  source: "orbio",
  totalAvailableCredit: 180,
  minBuyCredit: 5,
};
const buy = decide(book, DEFAULT_PARAMS);
if (buy.action !== "BUY" || buy.requestedAmount !== 5) {
  throw new Error("H: BUY behavior changed");
}
const wait = decide(book, { ...DEFAULT_PARAMS, minDiscountPercent: 40 });
if (wait.action !== "WAIT" || wait.requestedAmount != null) {
  throw new Error("H: WAIT behavior changed");
}

const read = await ledger.GET(new Request("http://localhost/api/ledger"));
const listed = (await read.json()) as { decisions?: unknown };
if (!read.ok || !Array.isArray(listed.decisions)) {
  throw new Error("Ledger read must stay available");
}

console.log("ledger mutation boundary ok");
