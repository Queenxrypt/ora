import { readFileSync } from "node:fs";
import { observationHistoryItems, observationViewFromRow } from "./observation-history";
import type { ObservationRow } from "../db/observations";

function assert(condition: unknown, label: string) {
  if (!condition) throw new Error(label);
}

const row = (overrides: Partial<ObservationRow> = {}): ObservationRow => ({
  slot_start: "2026-09-28T10:00:00.000Z",
  cadence_seconds: 300,
  outcome: "succeeded",
  attempted_at: "2026-09-28T10:00:01.000Z",
  completed_at: "2026-09-28T10:00:02.000Z",
  levels: [
    { discount_bps: 3000, credit_atoms: 71_804_922 },
    { discount_bps: 2500, credit_atoms: 11_815_216_096 },
  ],
  min_buy_credit_atoms: 5_000_000,
  reported_total_credit_atoms: 11_887_021_018,
  fingerprint: "v1:abc",
  http_status: null,
  error_detail: null,
  ...overrides,
});

const live = observationViewFromRow(row());
assert(live, "valid row becomes a history item");
assert(live?.slotStart === "2026-09-28T10:00:00.000Z", "slotStart is the stored slot");
assert(live?.bestDiscountPercent === 30, "best discount is first level bps / 100");
assert(live?.availableAtBestDiscount === 71.804922, "CREDIT at best uses atoms / 1e6");
assert(live?.totalAvailableCredit === 11_887.021018, "total uses reported atoms when present");
assert(live?.minBuyCredit === 5, "min buy uses atoms / 1e6");

const summed = observationViewFromRow(row({ reported_total_credit_atoms: null }));
assert(summed?.totalAvailableCredit === 11_887.021018, "missing reported total sums level atoms");

const empty = observationViewFromRow(row({ levels: [] }));
assert(empty, "empty levels is a valid empty book");
assert(empty?.bestDiscountPercent === null, "empty book does not invent 0% discount");
assert(empty?.availableAtBestDiscount === null, "empty book has no CREDIT at best");
assert(empty?.totalAvailableCredit === 11_887.021018, "empty book still uses reported total");

const emptyNoTotal = observationViewFromRow(
  row({ levels: [], reported_total_credit_atoms: null }),
);
assert(emptyNoTotal?.totalAvailableCredit === 0, "empty book without reported total is 0 CREDIT");

assert(observationViewFromRow(row({ levels: null })) === null, "null levels is skipped");
assert(
  observationViewFromRow(row({ levels: [{ discount_bps: 2500 }] })) === null,
  "malformed level is skipped",
);
assert(
  observationViewFromRow(
    row({
      levels: [
        { discount_bps: 3000, credit_atoms: 1 },
        { discount_bps: "x" as unknown as number, credit_atoms: 1 },
      ],
    }),
  ) === null,
  "one bad level skips the row",
);

const mixed = observationHistoryItems([
  row({ slot_start: "2026-09-28T10:05:00.000Z" }),
  row({ slot_start: "2026-09-28T10:00:00.000Z", levels: null }),
  row({ slot_start: "2026-09-28T09:55:00.000Z", levels: [] }),
]);
assert(mixed.length === 2, "malformed rows do not crash the list");
assert(mixed[0].slotStart === "2026-09-28T10:05:00.000Z", "valid rows keep order");
assert(mixed[1].bestDiscountPercent === null, "empty book remains in the list");

const historySource = readFileSync(
  new URL("../../app/app/history/page.tsx", import.meta.url),
  "utf8",
);
assert(
  !historySource.includes("market-history") &&
    !historySource.includes("/api/observations"),
  "Decision History page must not include Market History",
);

const observeSource = readFileSync(
  new URL("../../app/api/observe/route.ts", import.meta.url),
  "utf8",
);
assert(
  !observeSource.includes("readSucceededObservations"),
  "/api/observe must remain the writer",
);

const routeSource = readFileSync(
  new URL("../../app/api/observations/route.ts", import.meta.url),
  "utf8",
);
assert(routeSource.includes('export const dynamic = "force-dynamic"'), "observations route is dynamic");
assert(routeSource.includes("no-store"), "observations route is not cached");
assert(routeSource.includes("readSucceededObservations(24)"), "observations route asks for 24 rows");
assert(!routeSource.includes("readMarketSnapshot"), "history must not reread Orbio");
assert(!routeSource.includes("normalizeBook"), "history must not reuse unsafe normalizeBook");
assert(!routeSource.includes("wallet"), "observations route is not wallet-gated");

const deskSource = readFileSync(
  new URL("../../components/OraDeskPage.tsx", import.meta.url),
  "utf8",
);
const historyIndex = deskSource.indexOf('id="market-history"');
const settingsIndex = deskSource.indexOf('id="settings"');
const commandClose = deskSource.indexOf('className="command-center"');
assert(historyIndex > commandClose && historyIndex < settingsIndex, "Market History sits after live desk and before settings");
assert(!deskSource.includes("normalizeBook"), "desk history path must not call normalizeBook");

console.log("observation history checks passed");
