process.env.SUPABASE_URL = "http://supabase.test";
process.env.SUPABASE_SECRET_KEY = "test-secret";
process.env.ROBINHOOD_RPC_URL = "http://rpc.test";
process.env.ORBIO_MARKET_ORIGIN = "http://orbio.test";

import { readFileSync } from "node:fs";
import { decodeFunctionData, encodeFunctionResult, type Hex } from "viem";
import type { TargetAlertRow } from "../../db/alerts";
import type { DecisionRow } from "../../db/rows";
import type { TargetRow } from "../../db/targets";
import type { DecisionRecord, ProcurementTarget } from "../../../types/ora";

const { exchangeAbi } = await import("../../orbio/exchange");
const {
  cancelOwnedTarget,
  fulfillTargetFromDecision,
  reopenTargetFromDecision,
  requireOwnedTarget,
} = await import("../../db/targets");
const {
  alertStatusForPeriod,
  COOLDOWN_ALERT_STATUSES,
  cooldownReference,
  prepareReadyAlert,
  READY_ALERT_COOLDOWN_MS,
} = await import("./ready-alert");
const { recordReadyAlerts } = await import("./record-ready-alerts");
const { evaluateOpenTargetsAfterObservation, startedReadyPeriod } = await import(
  "../watch-targets"
);
const evaluateRoute = await import("../../../app/api/targets/evaluate/route");
const reviewRoute = await import("../../../app/api/targets/review/route");

function assert(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}

const WALLET = "0x5202d9b5a43448f939091eb25e6a7816aef3917d";

// ---------------------------------------------------------------------------
// Fake backend: PostgREST tables, the ready_since trigger, Orbio and the RPC.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

let targets: TargetRow[] = [];
let decisions: DecisionRow[] = [];
let alerts: TargetAlertRow[] = [];
let failingQuotes = false;
let failingAlertWrites = false;
let infoLog: string[] = [];
let clockMs = Date.parse("2026-10-05T09:00:00.000Z");

/** Postgres-style timestamp with microseconds, as PostgREST returns it. */
function dbNow(): string {
  return new Date(clockMs).toISOString().replace("Z", "321+00:00");
}

function advanceMinutes(minutes: number) {
  clockMs += minutes * 60_000;
}

// Read mutable fake state through functions so assertions do not narrow it.
const alertCount = () => alerts.length;
const logCount = () => infoLog.length;
const decisionCount = () => decisions.length;
const statusOf = (index: number): string => targets[index].status;

/** Mirrors procurement_targets_track_ready_since(). */
function applyReadySinceTrigger(row: TargetRow, previousStatus: string | null) {
  if (row.status === "READY") {
    row.ready_since =
      previousStatus === "READY" ? (row.ready_since ?? dbNow()) : dbNow();
  } else {
    row.ready_since = null;
  }
}

const qualifyingBook = {
  levels: [
    { discountBps: 2500, creditAtoms: 80_000_000 },
    { discountBps: 1000, creditAtoms: 100_000_000 },
  ],
  minBuyCreditAtoms: 5_000_000,
  reportedTotalCreditAtoms: 180_000_000,
  fingerprint: "obs-qualifying",
};
const thinBook = {
  levels: [{ discountBps: 2500, creditAtoms: 30_000_000 }],
  minBuyCreditAtoms: 5_000_000,
  reportedTotalCreditAtoms: 30_000_000,
  fingerprint: "obs-thin",
};
let liveBook = {
  rows: [
    { discountBps: 2500, microUsd: "80000000" },
    { discountBps: 1000, microUsd: "100000000" },
  ],
  totalMicroUsd: "180000000",
  minBuyMicroUsd: "5000000",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function matches(row: Row, column: string, expr: string): boolean {
  const value = row[column];
  const dot = expr.indexOf(".");
  const op = expr.slice(0, dot);
  const arg = expr.slice(dot + 1);
  if (op === "eq") return value != null && String(value) === arg;
  if (op === "in") {
    return arg.replace(/^\(|\)$/g, "").split(",").includes(String(value));
  }
  if (op === "is" && arg === "null") return value == null;
  throw new Error(`fake postgrest: unsupported filter ${column}=${expr}`);
}

const CONTROL_PARAMS = new Set(["select", "order", "limit", "on_conflict", "columns"]);

function query<T extends Row>(rows: T[], url: URL): T[] {
  let found = rows.filter((row) =>
    [...url.searchParams].every(
      ([key, expr]) => CONTROL_PARAMS.has(key) || matches(row, key, expr),
    ),
  );
  const order = url.searchParams.get("order");
  if (order) {
    const [column, direction] = order.split(".");
    found = [...found].sort((a, b) => {
      const av = String(a[column] ?? "");
      const bv = String(b[column] ?? "");
      return direction === "desc" ? bv.localeCompare(av) : av.localeCompare(bv);
    });
  }
  const limit = url.searchParams.get("limit");
  return limit ? found.slice(0, Number(limit)) : found;
}

function respondRows(rows: Row[], init: RequestInit | undefined, status = 200) {
  const accept = new Headers(init?.headers).get("accept") ?? "";
  if (!accept.includes("vnd.pgrst.object+json")) return json(rows, status);
  if (rows.length !== 1) {
    return json(
      { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" },
      406,
    );
  }
  return json(rows[0], status);
}

function rpcResult(data: Hex): Hex {
  const call = decodeFunctionData({ abi: exchangeAbi, data });
  if (call.functionName === "MAX_FILLS") {
    return encodeFunctionResult({ abi: exchangeAbi, functionName: "MAX_FILLS", result: 32n });
  }
  if (call.functionName === "getQuoteForCredit") {
    if (failingQuotes) throw new Error("rpc down");
    const [creditAtoms] = call.args as [bigint, bigint];
    return encodeFunctionResult({
      abi: exchangeAbi,
      functionName: "getQuoteForCredit",
      result: {
        creditOut: creditAtoms,
        usdgSpent: (creditAtoms * 75n) / 100n,
        feeAtoms: 0n,
        fills: 1n,
        reason: 0,
      },
    });
  }
  throw new Error(`fake rpc: unexpected ${call.functionName}`);
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
  );
  const method = (init?.method ?? "GET").toUpperCase();

  if (url.host === "orbio.test" && url.pathname === "/api/market/book") {
    return json(liveBook);
  }

  if (url.host === "rpc.test") {
    const parsed = JSON.parse(String(init?.body));
    const handle = (req: { id: number; method: string; params: unknown[] }) => {
      if (req.method === "eth_chainId") return { jsonrpc: "2.0", id: req.id, result: "0x1237" };
      if (req.method === "eth_call") {
        try {
          const data = (req.params[0] as { data: Hex }).data;
          return { jsonrpc: "2.0", id: req.id, result: rpcResult(data) };
        } catch (error) {
          return {
            jsonrpc: "2.0",
            id: req.id,
            error: { code: -32000, message: error instanceof Error ? error.message : "eth_call failed" },
          };
        }
      }
      return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `unexpected ${req.method}` } };
    };
    return json(Array.isArray(parsed) ? parsed.map(handle) : handle(parsed));
  }

  if (url.host === "supabase.test" && url.pathname === "/rest/v1/procurement_targets") {
    if (method === "GET") return respondRows(query(targets, url), init);
    if (method === "PATCH") {
      const found = query(targets, url);
      const patch = JSON.parse(String(init?.body)) as Partial<TargetRow>;
      for (const row of found) {
        const previousStatus = row.status;
        Object.assign(row, patch);
        applyReadySinceTrigger(row, previousStatus);
      }
      return respondRows(found, init);
    }
  }

  if (url.host === "supabase.test" && url.pathname === "/rest/v1/decisions") {
    if (method === "GET") return respondRows(query(decisions, url), init);
    if (method === "POST") {
      const body = JSON.parse(String(init?.body)) as DecisionRow;
      decisions.push(body);
      return respondRows([body], init, 201);
    }
    if (method === "PATCH") {
      const found = query(decisions, url);
      const patch = JSON.parse(String(init?.body)) as Partial<DecisionRow>;
      for (const row of found) Object.assign(row, patch);
      return respondRows(found, init);
    }
  }

  if (url.host === "supabase.test" && url.pathname === "/rest/v1/target_alerts") {
    if (method === "GET") return respondRows(query(alerts, url), init);
    if (method === "POST") {
      if (failingAlertWrites) {
        return json({ code: "XX000", message: "alert write failed", details: null, hint: null }, 500);
      }
      assert(
        url.searchParams.get("on_conflict") === "target_id,ready_since,channel",
        "alert insert conflicts on the READY period key",
      );
      const parsed = JSON.parse(String(init?.body)) as Partial<TargetAlertRow> | Partial<TargetAlertRow>[];
      const inserted: TargetAlertRow[] = [];
      for (const body of Array.isArray(parsed) ? parsed : [parsed]) {
        const conflict = alerts.some(
          (row) =>
            row.target_id === body.target_id &&
            row.ready_since === body.ready_since &&
            row.channel === body.channel,
        );
        if (conflict) continue;
        const row: TargetAlertRow = {
          id: String(body.id),
          target_id: String(body.target_id),
          wallet_address: String(body.wallet_address),
          channel: "telegram",
          ready_since: String(body.ready_since),
          status: body.status ?? "pending",
          attempts: body.attempts ?? 0,
          next_attempt_at: body.next_attempt_at ?? null,
          claimed_at: body.claimed_at ?? null,
          sent_at: body.sent_at ?? null,
          telegram_message_id: body.telegram_message_id ?? null,
          last_error: body.last_error ?? null,
          created_at: dbNow(),
        };
        alerts.push(row);
        inserted.push(row);
      }
      return json(inserted, 201);
    }
  }

  throw new Error(`fake fetch: unexpected ${method} ${url.href}`);
}) as typeof fetch;

console.info = (...args: unknown[]) => {
  infoLog.push(args.map(String).join(" "));
};

function reset() {
  targets = [];
  decisions = [];
  alerts = [];
  failingQuotes = false;
  failingAlertWrites = false;
  infoLog = [];
  clockMs = Date.parse("2026-10-05T09:00:00.000Z");
  liveBook = {
    rows: [
      { discountBps: 2500, microUsd: "80000000" },
      { discountBps: 1000, microUsd: "100000000" },
    ],
    totalMicroUsd: "180000000",
    minBuyMicroUsd: "5000000",
  };
}

function seedTarget(id: string, overrides: Partial<TargetRow> = {}): TargetRow {
  const row: TargetRow = {
    id,
    wallet_address: WALLET,
    requested_credit: 50,
    min_discount_percent: 20,
    max_spend_usdg: 40,
    status: "WATCHING",
    created_at: "2026-10-05T08:00:00.000Z",
    updated_at: "2026-10-05T08:00:00.000Z",
    cancelled_at: null,
    fulfilled_at: null,
    active_decision_id: null,
    fulfilled_decision_id: null,
    last_evaluated_at: null,
    last_evaluation_action: null,
    last_evaluation_reason: null,
    last_requested_amount: null,
    last_executable_discount_percent: null,
    last_executable_total_usdg: null,
    ready_since: null,
    ...overrides,
  };
  targets.push(row);
  return row;
}

const READY_FIELDS = {
  status: "READY",
  last_evaluated_at: "2026-10-05T08:30:00.000Z",
  last_evaluation_action: "BUY",
  last_evaluation_reason: "ready fixture",
  last_requested_amount: 50,
  last_executable_discount_percent: 25,
  last_executable_total_usdg: 37.5,
  ready_since: "2026-10-05T08:30:00.000000+00:00",
} as const;

async function post(
  route: { POST: (request: Request) => Promise<Response> },
  path: string,
  body: Record<string, unknown>,
) {
  const res = await route.POST(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function successRecord(targetId: string): DecisionRecord {
  return {
    id: "dec-success",
    timestamp: "2026-10-05T09:00:00.000Z",
    market: { price: 0.75, discountPercent: 25, availableDepth: 80 },
    snapshot: {
      timestamp: "2026-10-05T09:00:00.000Z",
      creditPrice: 0.75,
      discountPercent: 25,
      bestDiscount: 25,
      availableAtBestDiscount: 80,
      depth: [{ discountPercent: 25, availableCredit: 80 }],
      source: "orbio",
      totalAvailableCredit: 80,
      minBuyCredit: 5,
    },
    decision: "BUY",
    reason: "fixture",
    requestedAmount: 50,
    walletAddress: WALLET as `0x${string}`,
    targetId,
    executionStatus: "success",
    confirmedAt: "2026-10-05T09:05:00.000Z",
  };
}

// ---------------------------------------------------------------------------
// Pure rules: cooldown, transition detection, payload.
// ---------------------------------------------------------------------------

{
  const start = "2026-10-05T09:00:00.000000+00:00";
  const at = (minutes: number, seconds = 0) =>
    new Date(Date.parse(start) + minutes * 60_000 + seconds * 1000).toISOString();
  assert(READY_ALERT_COOLDOWN_MS === 30 * 60 * 1000, "cooldown is 30 minutes");
  assert(alertStatusForPeriod(start, null) === "pending", "first READY period is eligible");
  assert(alertStatusForPeriod(at(29, 59), start) === "suppressed", "29:59 after an alert is suppressed");
  assert(alertStatusForPeriod(at(30), start) === "pending", "30:00 after an alert is eligible");
  assert(alertStatusForPeriod(at(45), start) === "pending", "45 minutes after an alert is eligible");
  assert(alertStatusForPeriod(start, "not a time") === "suppressed", "unreadable cooldown reference is suppressed");
  for (const status of ["suppressed", "skipped", "failed_permanent"] as const) {
    assert(!COOLDOWN_ALERT_STATUSES.includes(status), `${status} alerts do not start a cooldown`);
  }
  for (const status of ["pending", "sending", "sent", "unknown", "failed_retryable"] as const) {
    assert(COOLDOWN_ALERT_STATUSES.includes(status), `${status} alerts start a cooldown`);
  }
  assert(
    cooldownReference({ sent_at: at(2), created_at: start }) === at(2),
    "a sent alert's cooldown runs from when it was sent",
  );
  assert(
    cooldownReference({ sent_at: null, created_at: start }) === start,
    "an unsent alert's cooldown runs from when it was recorded",
  );
}

{
  const ready = { status: "READY", readySince: "2026-10-05T09:00:00.000321+00:00" } as ProcurementTarget;
  const written = { kind: "written", target: ready } as const;
  assert(startedReadyPeriod({ status: "WATCHING" }, written), "WATCHING → READY starts a READY period");
  assert(!startedReadyPeriod({ status: "READY" }, written), "READY → READY does not");
  assert(
    !startedReadyPeriod({ status: "READY" }, { kind: "written", target: { ...ready, status: "WATCHING" } }),
    "READY → WATCHING does not",
  );
  assert(!startedReadyPeriod({ status: "WATCHING" }, { kind: "inconclusive" }), "inconclusive does not");
  assert(!startedReadyPeriod({ status: "WATCHING" }, { kind: "superseded" }), "superseded does not");
  assert(!startedReadyPeriod({ status: "WATCHING" }, { kind: "in_flight" }), "in-flight does not");
}

{
  const target = {
    id: "tgt-secret-id",
    walletAddress: WALLET as `0x${string}`,
    status: "READY",
    requestedCredit: 50,
    readySince: "2026-10-05T09:41:30.000321+00:00",
    lastEvaluatedAt: "2026-10-05T09:41:27.000Z",
    lastRequestedAmount: 50,
    lastExecutableDiscountPercent: 21.4,
    lastExecutableTotalUsdg: 39.3,
    activeDecisionId: "dec-secret-id",
  } as ProcurementTarget;
  const payload = prepareReadyAlert(target);
  assert(payload, "READY target with executable facts prepares an alert");
  assert(
    payload.text ===
      [
        "Ora — procurement target READY",
        "",
        "Requested: 50 CREDIT",
        "Executable discount: 21.4%",
        "Quoted cost: 39.30 USDG (quoted 09:41 UTC)",
        "",
        "Nothing has been purchased. Prices can change.",
        "",
        "Open Ora to re-check the market and review. Ora never buys without your wallet signature.",
      ].join("\n"),
    `alert text matches the agreed message (got ${JSON.stringify(payload.text)})`,
  );
  assert(
    JSON.stringify(Object.keys(payload).sort()) ===
      JSON.stringify(
        ["executableDiscountPercent", "quotedAt", "quotedCostUsdg", "readySince", "requestedCredit", "text"].sort(),
      ),
    "payload carries only the alert facts",
  );
  const serialized = JSON.stringify(payload).toLowerCase();
  for (const secret of [WALLET.toLowerCase(), "tgt-secret-id", "dec-secret-id", "0x"]) {
    assert(!serialized.includes(secret), `payload does not contain ${secret}`);
  }
  assert(
    !/\b(bought|executed|confirmed|complete[d]?|signed)\b/i.test(payload.text),
    "alert never claims a purchase happened",
  );
  assert(
    prepareReadyAlert({ ...target, lastExecutableTotalUsdg: undefined }) == null,
    "missing executable cost prepares no alert",
  );
  assert(prepareReadyAlert({ ...target, status: "WATCHING" }) == null, "WATCHING target prepares no alert");
  assert(prepareReadyAlert({ ...target, readySince: undefined }) == null, "READY without a period prepares no alert");
}

// ---------------------------------------------------------------------------
// Scheduler-driven READY periods.
// ---------------------------------------------------------------------------

// 1. WATCHING → READY by the scheduler creates one Telegram alert opportunity.
reset();
{
  seedTarget("tgt-1");
  const results = await evaluateOpenTargetsAfterObservation(qualifyingBook);
  assert(results[0].result === "written" && statusOf(0) === "READY", "scheduler READYs the target");
  const readySince = targets[0].ready_since;
  assert(readySince === dbNow(), "READY transition starts a READY period");
  assert(alertCount() === 1, `one alert opportunity (got ${alerts.length})`);
  const alert = alerts[0];
  assert(alert.target_id === "tgt-1" && alert.wallet_address === WALLET, "alert belongs to the target and wallet");
  assert(alert.channel === "telegram", "alert channel is telegram");
  assert(alert.status === "pending", "first alert is eligible for sending");
  assert(alert.ready_since === readySince, "alert keys on the exact database ready_since");
  assert(alert.attempts === 0 && alert.sent_at == null, "nothing has been sent");
  assert(logCount() === 1 && infoLog[0].includes("Ora — procurement target READY"), "eligible alert is logged");
  assert(infoLog[0].includes("Quoted cost: 37.50 USDG"), "logged alert carries the executable cost");
  assert(infoLog[0].includes("Executable discount: 25%"), "logged alert carries the executable discount");
  assert(!infoLog[0].toLowerCase().includes(WALLET), "logged alert omits the wallet");
  assert(decisionCount() === 0, "alerting creates no decision");

  // 2 + 3 + 11. Observed again while READY: same period, no new alert.
  advanceMinutes(1);
  const again = await evaluateOpenTargetsAfterObservation(qualifyingBook);
  assert(again[0].result === "written" && statusOf(0) === "READY", "target stays READY");
  assert(targets[0].ready_since === readySince, "ready_since is stable while READY");
  assert(alertCount() === 1, "READY → READY creates no new alert");
  assert(logCount() === 1, "READY → READY logs nothing");

  // 12 + 4. READY → WATCHING clears the period and creates no alert.
  advanceMinutes(1);
  await evaluateOpenTargetsAfterObservation(thinBook);
  assert(statusOf(0) === "WATCHING", "thin book returns the target to WATCHING");
  assert(targets[0].ready_since == null, "ready_since clears when the target leaves READY");
  assert(alertCount() === 1, "READY → WATCHING creates no alert");
}

// 8. The same READY period cannot produce two alert rows, even if recorded twice.
reset();
{
  seedTarget("tgt-8");
  await evaluateOpenTargetsAfterObservation(qualifyingBook);
  const access = await requireOwnedTarget("tgt-8", WALLET);
  assert("target" in access, "READY target readable");
  const repeated = await recordReadyAlerts([access.target]);
  assert(repeated[0].result === "duplicate", "second record for the same period is a duplicate");
  const concurrent = await Promise.all([
    recordReadyAlerts([access.target]),
    recordReadyAlerts([access.target]),
  ]);
  assert(concurrent.flat().every((r) => r.result === "duplicate"), "concurrent records are duplicates");
  assert(alertCount() === 1, `one alert row per READY period (got ${alerts.length})`);
  assert(logCount() === 1, "duplicates are not logged as new alerts");
}

// 7. Inconclusive evaluation on a WATCHING target: no state change, no alert.
reset();
{
  seedTarget("tgt-7");
  const before = JSON.stringify(targets[0]);
  failingQuotes = true;
  const results = await evaluateOpenTargetsAfterObservation(qualifyingBook);
  assert(results[0].result === "inconclusive", "quote failure is inconclusive");
  assert(JSON.stringify(targets[0]) === before, "inconclusive evaluation leaves the target unchanged");
  assert(alertCount() === 0, "inconclusive evaluation creates no alert");
}

// 5. Page-load evaluation READYs the target without an alert, and the
// scheduler then sees READY → READY, so no alert follows later either.
reset();
{
  seedTarget("tgt-5");
  const live = await post(evaluateRoute, "/api/targets/evaluate", { targetId: "tgt-5", walletAddress: WALLET });
  assert(live.status === 200, "page-load evaluate succeeds");
  const target = live.body.target as ProcurementTarget;
  assert(target.status === "READY" && target.readySince === dbNow(), "page load starts a READY period");
  assert(alertCount() === 0, "page-load READY creates no alert");
  advanceMinutes(1);
  await evaluateOpenTargetsAfterObservation(qualifyingBook);
  assert(targets[0].ready_since === target.readySince, "scheduler keeps the page-load READY period");
  assert(alertCount() === 0, "scheduler does not alert for a READY period it did not start");
}

// 6. Review READYs the target without an alert.
reset();
{
  seedTarget("tgt-6");
  const reviewed = await post(reviewRoute, "/api/targets/review", { targetId: "tgt-6", walletAddress: WALLET });
  assert(reviewed.status === 200, `review succeeds (got ${reviewed.status}: ${JSON.stringify(reviewed.body)})`);
  assert(statusOf(0) === "READY" && targets[0].ready_since != null, "review starts a READY period");
  assert(decisionCount() === 1, "review still creates its BUY decision");
  assert(alertCount() === 0, "review READY creates no alert");
  advanceMinutes(1);
  await evaluateOpenTargetsAfterObservation(qualifyingBook);
  assert(alertCount() === 0, "scheduler does not alert for a reviewed READY period");
}

// Existing READY targets (backfilled by the migration) never produce historical alerts.
reset();
{
  seedTarget("tgt-existing", { ...READY_FIELDS });
  await evaluateOpenTargetsAfterObservation(qualifyingBook);
  assert(statusOf(0) === "READY", "existing READY target stays READY");
  assert(targets[0].ready_since === READY_FIELDS.ready_since, "existing READY period is preserved");
  assert(alertCount() === 0, "existing READY target creates no alert");
}

// 9 + 10. A new READY period inside 30 minutes is suppressed; after 30 it is eligible.
reset();
{
  seedTarget("tgt-cooldown");
  await evaluateOpenTargetsAfterObservation(qualifyingBook);
  assert(alertCount() === 1 && alerts[0].status === "pending", "first period alert is eligible");

  advanceMinutes(5);
  await evaluateOpenTargetsAfterObservation(thinBook);
  advanceMinutes(5);
  await evaluateOpenTargetsAfterObservation(qualifyingBook);
  assert(alertCount() === 2, "second READY period gets its own record");
  assert(alerts[1].status === "suppressed", "READY period 10 minutes after an alert is suppressed");
  assert(alerts[1].ready_since === targets[0].ready_since, "suppressed record keys on the new period");
  assert(logCount() === 1, "suppressed alert is not prepared for sending");
  assert(statusOf(0) === "READY", "cooldown does not change the target state");

  advanceMinutes(5);
  await evaluateOpenTargetsAfterObservation(thinBook);
  advanceMinutes(16);
  await evaluateOpenTargetsAfterObservation(qualifyingBook);
  assert(alertCount() === 3, "third READY period gets its own record");
  assert(alerts[2].status === "pending", "READY period 31 minutes after the last alert is eligible");
  assert(logCount() === 2, "eligible alert after the cooldown is prepared");

  advanceMinutes(2);
  await evaluateOpenTargetsAfterObservation(thinBook);
  advanceMinutes(7);
  await evaluateOpenTargetsAfterObservation(qualifyingBook);
  assert(alerts[3]?.status === "suppressed", "cooldown restarts from the latest eligible alert");
}

// Alert failure never breaks target evaluation.
reset();
{
  seedTarget("tgt-alert-down");
  failingAlertWrites = true;
  const errors = console.error;
  console.error = () => {};
  const results = await evaluateOpenTargetsAfterObservation(qualifyingBook);
  console.error = errors;
  assert(results[0].result === "written", "evaluation result is unchanged by an alert failure");
  assert(statusOf(0) === "READY" && targets[0].ready_since != null, "target stays READY when alerting fails");
  assert(alertCount() === 0, "failed alert write records nothing");
}

// 12. ready_since clears on every path out of READY.
reset();
{
  seedTarget("tgt-cancel", { ...READY_FIELDS });
  const cancelled = await cancelOwnedTarget("tgt-cancel", WALLET);
  assert("target" in cancelled && cancelled.target.status === "CANCELLED", "READY target cancels");
  assert(targets[0].ready_since == null && cancelled.target.readySince == null, "READY → CANCELLED clears ready_since");

  seedTarget("tgt-fulfil", { ...READY_FIELDS, wallet_address: WALLET });
  const fulfilled = await fulfillTargetFromDecision(successRecord("tgt-fulfil"));
  assert(fulfilled?.status === "FULFILLED", "READY target fulfils");
  assert(targets[1].ready_since == null, "READY → FULFILLED clears ready_since");

  seedTarget("tgt-reopen", { ...READY_FIELDS });
  const reopened = await reopenTargetFromDecision(successRecord("tgt-reopen"));
  assert(reopened?.status === "WATCHING", "READY target reopens to WATCHING");
  assert(targets[2].ready_since == null, "READY → WATCHING via reopen clears ready_since");
  assert(alertCount() === 0, "leaving READY creates no alert");
}

// ---------------------------------------------------------------------------
// 13. The alert layer is isolated from purchase, quote and validation code.
// ---------------------------------------------------------------------------

const src = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const watchSource = src("../watch-targets.ts");
const evaluateAndPersist = watchSource.slice(
  watchSource.indexOf("export async function evaluateAndPersistTarget"),
  watchSource.indexOf("export function startedReadyPeriod"),
);
assert(evaluateAndPersist.length > 0, "evaluateAndPersistTarget located");
assert(!/alert/i.test(evaluateAndPersist), "shared evaluate-and-persist path has no alert logic");
const liveEvaluation = watchSource.slice(watchSource.indexOf("export async function evaluateOwnedTargetLive"));
assert(!/alert/i.test(liveEvaluation), "page-load evaluation has no alert logic");

for (const path of [
  "../../../app/api/targets/evaluate/route.ts",
  "../../../app/api/targets/review/route.ts",
  "../../../app/api/quote/route.ts",
  "../../../app/api/execute/validate/route.ts",
  "../../../app/api/execute/confirm/route.ts",
  "../../../app/api/execute/receipt/route.ts",
  "../../../app/api/execute/abort/route.ts",
  "../../../app/api/observe/route.ts",
]) {
  assert(!/alert/i.test(src(path)), `${path} does not touch alerts`);
}

for (const path of ["./ready-alert.ts", "./record-ready-alerts.ts", "../../db/alerts.ts"]) {
  const source = src(path);
  for (const forbidden of [
    "quoteForCredit",
    "appendDecision",
    "updateOwnedDecision",
    "persistTargetEvaluation",
    "execute/",
    "api.telegram.org",
    "fetch(",
  ]) {
    assert(!source.includes(forbidden), `${path} does not reference ${forbidden}`);
  }
}

const targetsSource = src("../../db/targets.ts");
assert(
  (targetsSource.match(/ready_since:/g) ?? []).length === 1,
  "no target write sets ready_since; the database trigger owns it",
);

const migration = src("../../../supabase/migrations/20261005120000_target_ready_alerts.sql");
for (const needle of [
  "before insert or update on public.procurement_targets",
  "new.ready_since := coalesce(old.ready_since, new.ready_since, now())",
  "new.ready_since := null",
  "check ((status = 'READY') = (ready_since is not null))",
  "unique (target_id, ready_since, channel)",
  "check (channel in ('telegram'))",
  "alter table public.target_alerts enable row level security",
]) {
  assert(migration.includes(needle), `migration contains ${needle}`);
}
assert(!/set\s+updated_at/i.test(migration), "migration backfill does not touch updated_at");

console.log("ready alerts ok");
