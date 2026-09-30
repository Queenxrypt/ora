import { readFileSync } from "node:fs";
import type { ObservationRow } from "../db/observations";

process.env.SUPABASE_URL = "http://supabase.test";
process.env.SUPABASE_SECRET_KEY = "test-secret";
process.env.ORBIO_MARKET_ORIGIN = "http://orbio.test";
process.env.CRON_SECRET = "test-cron-secret";
delete process.env.OBSERVATION_CADENCE_SECONDS;

const {
  bookFingerprint,
  DEFAULT_OBSERVATION_CADENCE_SECONDS,
  fetchObservedBook,
  observationCadenceSeconds,
  observationSlot,
  validateBook,
} = await import("./book-observation");
const { completionPatch } = await import("../db/observations");
const route = await import("../../app/api/observe/route");

function assert(condition: unknown, label: string) {
  if (!condition) throw new Error(label);
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const liveBook = {
  rows: [
    { discountBps: 2750, microUsd: "31587333" },
    { discountBps: 3000, microUsd: "71804922" },
    { discountBps: 2500, microUsd: "11815216096" },
    { discountBps: 1250, microUsd: "0" },
  ],
  managedRows: [],
  bids: [],
  totalMicroUsd: "11918608351",
  bidTotalMicroUsd: "0",
  minBuyMicroUsd: "5000000",
  stepBps: 250,
  minDiscountBps: 1000,
  maxDiscountBps: 8000,
  maxBidDiscountBps: 5000,
  rails: { card: true, bid: false },
};

// ---------------------------------------------------------------------------
// Cadence and slots.
// ---------------------------------------------------------------------------

assert(DEFAULT_OBSERVATION_CADENCE_SECONDS === 300, "default cadence is 5 minutes");
assert(observationCadenceSeconds(undefined) === 300, "unset cadence uses the default");
assert(observationCadenceSeconds("  ") === 300, "blank cadence uses the default");
assert(observationCadenceSeconds("60") === 60, "1-minute cadence is the minimum");
assert(observationCadenceSeconds("420") === 420, "cadence need not divide an hour");
assert(observationCadenceSeconds("900") === 900, "15-minute cadence is accepted");
assert(observationCadenceSeconds("5400") === 5400, "cadence need not divide an hour");
assert(observationCadenceSeconds("7200") === 7200, "2-hour cadence is accepted");
assert(observationCadenceSeconds("86400") === 86_400, "1-day cadence is the safety bound");
for (const bad of ["0", "1", "30", "59", "-300", "abc", "300.5", "86401", "172800"]) {
  let threw = false;
  try {
    observationCadenceSeconds(bad);
  } catch {
    threw = true;
  }
  assert(threw, `cadence ${bad} is rejected`);
}

const slot = (iso: string, cadence = 300) =>
  observationSlot(new Date(iso), cadence).toISOString();
assert(slot("2026-09-27T10:00:00.000Z") === "2026-09-27T10:00:00.000Z", "boundary opens its own slot");
assert(slot("2026-09-27T10:03:00.000Z") === "2026-09-27T10:00:00.000Z", "10:03 floors to 10:00");
assert(slot("2026-09-27T10:04:59.999Z") === "2026-09-27T10:00:00.000Z", "10:04:59.999 floors to 10:00, never 10:05");
assert(slot("2026-09-27T10:05:00.000Z") === "2026-09-27T10:05:00.000Z", "10:05 opens the 10:05 slot");
assert(slot("2026-09-27T10:05:30.000Z", 60) === "2026-09-27T10:05:00.000Z", "1-minute slots floor too");

// ---------------------------------------------------------------------------
// Validation and normalization.
// ---------------------------------------------------------------------------

function valid(raw: unknown) {
  const result = validateBook(raw);
  if (!result.ok) throw new Error(`expected valid book: ${result.detail}`);
  return result.book;
}

function invalid(raw: unknown, label: string) {
  const result = validateBook(raw);
  if (result.ok) throw new Error(`${label}: must be invalid`);
  assert(result.detail.length > 0, `${label}: carries a detail`);
}

const live = valid(liveBook);
assert(
  JSON.stringify(live.levels) ===
    JSON.stringify([
      { discountBps: 3000, creditAtoms: 71804922 },
      { discountBps: 2750, creditAtoms: 31587333 },
      { discountBps: 2500, creditAtoms: 11815216096 },
    ]),
  "levels are exact atoms, highest discount first, zero levels dropped",
);
assert(live.minBuyCreditAtoms === 5_000_000, "minimum buy recorded in atoms");
assert(live.reportedTotalCreditAtoms === 11_918_608_351, "reported total recorded in atoms");
assert(/^v1:[0-9a-f]{64}$/.test(live.fingerprint), "fingerprint is versioned sha256");

const asNumbers = valid({
  ...liveBook,
  rows: liveBook.rows.map((row) => ({ ...row, microUsd: Number(row.microUsd) })),
});
assert(asNumbers.fingerprint === live.fingerprint, "integer microUsd matches digit-string microUsd");
assert(
  valid({ ...liveBook, rows: [...liveBook.rows].reverse() }).fingerprint === live.fingerprint,
  "row order does not change the fingerprint",
);
assert(
  valid({ ...liveBook, rows: liveBook.rows.filter((row) => row.microUsd !== "0") }).fingerprint ===
    live.fingerprint,
  "zero-amount levels do not change the fingerprint",
);
assert(
  valid({ ...liveBook, bids: [{ discountBps: 100, microUsd: "1" }], managedRows: [{}], rails: null })
    .fingerprint === live.fingerprint,
  "ignored fields do not change the fingerprint",
);

const mismatch = valid({ ...liveBook, totalMicroUsd: "1" });
assert(mismatch.reportedTotalCreditAtoms === 1, "total mismatch is accepted and recorded as reported");
assert(mismatch.fingerprint === live.fingerprint, "reported total is not part of the market state");

const changedLevel = valid({
  ...liveBook,
  rows: liveBook.rows.map((row) =>
    row.discountBps === 3000 ? { ...row, microUsd: "51804922" } : row,
  ),
});
assert(changedLevel.fingerprint !== live.fingerprint, "a level amount change changes the fingerprint");
assert(
  valid({ ...liveBook, minBuyMicroUsd: "1000000" }).fingerprint !== live.fingerprint,
  "a minimum buy change changes the fingerprint",
);

const empty = valid({ rows: [], totalMicroUsd: "0", minBuyMicroUsd: "5000000" });
assert(empty.levels.length === 0, "empty book is valid with no levels");
assert(empty.reportedTotalCreditAtoms === 0, "empty book keeps its reported zero total");
assert(empty.fingerprint === bookFingerprint([], 5_000_000), "empty book has a fingerprint");

for (const [label, value] of [
  ["missing", undefined],
  ["non-numeric", "abc"],
  ["zero", "0"],
  ["negative", -1],
  ["decimal", "1.5"],
] as const) {
  const book = valid({ ...liveBook, minBuyMicroUsd: value });
  assert(book.minBuyCreditAtoms === null, `${label} minimum buy is null, never defaulted`);
}
for (const [label, value] of [
  ["missing", undefined],
  ["non-numeric", "abc"],
  ["negative", -5],
  ["unsafe", "99999999999999999999"],
] as const) {
  const book = valid({ ...liveBook, totalMicroUsd: value });
  assert(book.reportedTotalCreditAtoms === null, `${label} total is null and does not fail`);
}

invalid(null, "null body");
invalid([], "array body");
invalid("book", "string body");
invalid({}, "missing rows");
invalid({ rows: {} }, "rows is not an array");
invalid({ rows: [null] }, "row is not an object");
invalid({ rows: [{ microUsd: "1" }] }, "missing discountBps");
invalid({ rows: [{ discountBps: "2500", microUsd: "1" }] }, "string discountBps");
invalid({ rows: [{ discountBps: 2500.5, microUsd: "1" }] }, "fractional discountBps");
invalid({ rows: [{ discountBps: -1, microUsd: "1" }] }, "negative discountBps");
invalid({ rows: [{ discountBps: 10_001, microUsd: "1" }] }, "discountBps above 10000");
invalid({ rows: [{ discountBps: 2500 }] }, "missing microUsd");
invalid({ rows: [{ discountBps: 2500, microUsd: "" }] }, "empty microUsd");
invalid({ rows: [{ discountBps: 2500, microUsd: "1.5" }] }, "decimal microUsd string");
invalid({ rows: [{ discountBps: 2500, microUsd: "-1" }] }, "negative microUsd string");
invalid({ rows: [{ discountBps: 2500, microUsd: 1.5 }] }, "fractional microUsd number");
invalid({ rows: [{ discountBps: 2500, microUsd: -1 }] }, "negative microUsd number");
invalid({ rows: [{ discountBps: 2500, microUsd: "99999999999999999999" }] }, "unsafe microUsd string");
invalid({ rows: [{ discountBps: 2500, microUsd: 2 ** 53 }] }, "unsafe microUsd number");
invalid(
  { rows: [{ discountBps: 2500, microUsd: "1" }, { discountBps: 2500, microUsd: "2" }] },
  "duplicate discountBps",
);

// Failures never carry market state.
for (const result of [
  { outcome: "timeout", detail: "t" },
  { outcome: "network", detail: "n" },
  { outcome: "invalid_payload", detail: "i" },
  { outcome: "http_error", httpStatus: 503, detail: "h" },
] as const) {
  const patch = completionPatch(result, new Date("2026-09-27T10:00:01.000Z"));
  assert(patch.levels === null && patch.fingerprint === null, `${result.outcome} carries no levels or fingerprint`);
  assert(patch.min_buy_credit_atoms === null && patch.reported_total_credit_atoms === null, `${result.outcome} carries no amounts`);
}

// ---------------------------------------------------------------------------
// In-memory Orbio and PostgREST.
// ---------------------------------------------------------------------------

type OrbioHandler = (init: RequestInit | undefined) => Promise<Response>;

let orbio: OrbioHandler = async () => json(liveBook);
let rows: ObservationRow[] = [];
const calls = { orbio: 0, claims: 0, updates: 0 };
const db = { failInsert: false, failUpdate: false };
let lastOrbioInit: RequestInit | undefined;

function reset(handler: OrbioHandler = async () => json(liveBook)) {
  orbio = handler;
  rows = [];
  calls.orbio = 0;
  calls.claims = 0;
  calls.updates = 0;
  db.failInsert = false;
  db.failUpdate = false;
  lastOrbioInit = undefined;
}

/** Mirrors the table's check constraints so the app cannot write a row Postgres would reject. */
function assertStorable(row: ObservationRow) {
  const epoch = Date.parse(row.slot_start) / 1000;
  assert(row.cadence_seconds > 0 && epoch % row.cadence_seconds === 0, "db: slot aligned to cadence");
  assert(
    ["succeeded", "incomplete", "timeout", "network", "http_error", "invalid_payload"].includes(row.outcome),
    "db: known outcome",
  );
  if (row.outcome === "succeeded") {
    assert(row.completed_at != null && Array.isArray(row.levels) && row.fingerprint != null, "db: success has state");
    assert(row.min_buy_credit_atoms == null || row.min_buy_credit_atoms > 0, "db: positive minimum buy");
    assert(row.reported_total_credit_atoms == null || row.reported_total_credit_atoms >= 0, "db: non-negative total");
    assert(row.http_status == null && row.error_detail == null, "db: success has no error");
  } else {
    assert(row.levels == null && row.fingerprint == null, "db: failure has no levels or fingerprint");
    assert(row.min_buy_credit_atoms == null && row.reported_total_credit_atoms == null, "db: failure has no amounts");
    assert((row.completed_at == null) === (row.outcome === "incomplete"), "db: only incomplete lacks completed_at");
    assert((row.http_status != null) === (row.outcome === "http_error"), "db: http_status only on http_error");
  }
}

function dbError(message: string) {
  return json({ code: "XX000", message, details: null, hint: null }, 500);
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const method = (init?.method ?? "GET").toUpperCase();
  if (url.host === "orbio.test" && url.pathname === "/api/market/book") {
    calls.orbio += 1;
    lastOrbioInit = init;
    return orbio(init);
  }
  if (url.host === "supabase.test" && url.pathname === "/rest/v1/market_observations") {
    if (method === "POST") {
      calls.claims += 1;
      if (db.failInsert) return dbError("insert failed");
      const prefer = new Headers(init?.headers).get("prefer") ?? "";
      assert(prefer.includes("resolution=ignore-duplicates"), "claim ignores duplicates");
      assert(url.searchParams.get("on_conflict") === "slot_start", "claim conflicts on slot_start");
      const body = JSON.parse(String(init?.body)) as Partial<ObservationRow>;
      const row: ObservationRow = {
        slot_start: String(body.slot_start),
        cadence_seconds: Number(body.cadence_seconds),
        outcome: body.outcome as ObservationRow["outcome"],
        attempted_at: String(body.attempted_at),
        completed_at: body.completed_at ?? null,
        levels: body.levels ?? null,
        min_buy_credit_atoms: body.min_buy_credit_atoms ?? null,
        reported_total_credit_atoms: body.reported_total_credit_atoms ?? null,
        fingerprint: body.fingerprint ?? null,
        http_status: body.http_status ?? null,
        error_detail: body.error_detail ?? null,
      };
      if (rows.some((existing) => existing.slot_start === row.slot_start)) return json([], 201);
      assertStorable(row);
      rows.push(row);
      return json([{ slot_start: row.slot_start }], 201);
    }
    if (method === "PATCH") {
      calls.updates += 1;
      if (db.failUpdate) return dbError("update failed");
      const patch = JSON.parse(String(init?.body)) as Partial<ObservationRow>;
      const matched = rows.filter((row) => {
        for (const [key, expr] of url.searchParams) {
          if (key === "select") continue;
          assert(expr.startsWith("eq."), `fake postgrest: unsupported filter ${key}=${expr}`);
          if (String((row as Record<string, unknown>)[key]) !== expr.slice(3)) return false;
        }
        return true;
      });
      for (const row of matched) {
        const next = { ...row, ...patch };
        assertStorable(next);
        Object.assign(row, next);
      }
      return json(matched.map((row) => ({ slot_start: row.slot_start })));
    }
  }
  if (url.host === "supabase.test" && url.pathname === "/rest/v1/procurement_targets") {
    if (method === "GET") return json([]);
  }
  throw new Error(`fake fetch: unexpected ${method} ${url.href}`);
}) as typeof fetch;

function hang(init: RequestInit | undefined): Promise<Response> {
  return new Promise((_, reject) => {
    const signal = init?.signal;
    if (!signal) throw new Error("Orbio request carries an abort signal");
    // AbortSignal.timeout timers are unref'd; keep the process alive until it fires.
    const keepAlive = setInterval(() => {}, 1_000);
    signal.addEventListener(
      "abort",
      () => {
        clearInterval(keepAlive);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

// ---------------------------------------------------------------------------
// fetchObservedBook.
// ---------------------------------------------------------------------------

reset();
let fetched = await fetchObservedBook();
assert(fetched.outcome === "succeeded" && fetched.book.fingerprint === live.fingerprint, "valid book succeeds");
assert(lastOrbioInit?.cache === "no-store", "Orbio read is not cached");
assert(lastOrbioInit?.signal instanceof AbortSignal, "Orbio read has a timeout signal");
assert(lastOrbioInit?.method == null || lastOrbioInit.method === "GET", "Orbio read is a GET");

for (const status of [429, 500, 503, 404, 302]) {
  reset(async () => new Response("nope", { status }));
  fetched = await fetchObservedBook();
  assert(fetched.outcome === "http_error" && fetched.httpStatus === status, `HTTP ${status} is http_error`);
  assert(calls.orbio === 1, `HTTP ${status} is not retried`);
}

reset(async () => new Response("<html>", { status: 200 }));
fetched = await fetchObservedBook();
assert(fetched.outcome === "invalid_payload", "non-JSON 200 is invalid_payload");

reset(async () => json({ rows: "none" }));
fetched = await fetchObservedBook();
assert(fetched.outcome === "invalid_payload", "malformed 200 is invalid_payload");

reset(async () => {
  throw new TypeError("fetch failed");
});
fetched = await fetchObservedBook();
assert(fetched.outcome === "network", "connection failure is network");

reset(hang);
const started = Date.now();
fetched = await fetchObservedBook(25);
assert(fetched.outcome === "timeout", "slow Orbio read is timeout");
assert(Date.now() - started < 2_000, "timeout aborts the read");
assert(calls.orbio === 1, "timeout is not retried");

// ---------------------------------------------------------------------------
// GET /api/observe.
// ---------------------------------------------------------------------------

const AUTH = { authorization: "Bearer test-cron-secret" };

function call(headers: Record<string, string> = AUTH, path = "/api/observe") {
  return route.GET(new Request(`http://localhost${path}`, { headers }));
}

async function body(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

// Authentication.
for (const [label, headers, path] of [
  ["no header", {}, "/api/observe"],
  ["wrong secret", { authorization: "Bearer wrong" }, "/api/observe"],
  ["no Bearer prefix", { authorization: "test-cron-secret" }, "/api/observe"],
  ["query-string secret", {}, "/api/observe?secret=test-cron-secret&token=test-cron-secret"],
  ["query-string bearer", {}, "/api/observe?authorization=Bearer%20test-cron-secret"],
] as const) {
  reset();
  const response = await call(headers, path);
  assert(response.status === 401, `${label} is rejected`);
  assert(calls.claims === 0 && calls.orbio === 0, `${label} does no work`);
}

const savedSecret = process.env.CRON_SECRET;
for (const unset of [undefined, "", "   "]) {
  reset();
  if (unset === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = unset;
  const attempts: Record<string, string>[] = [
    {},
    { authorization: "Bearer " },
    { authorization: "Bearer undefined" },
  ];
  for (const headers of attempts) {
    const response = await call(headers);
    assert(response.status === 401, "unset CRON_SECRET rejects every call");
  }
  assert(calls.claims === 0 && calls.orbio === 0, "unset CRON_SECRET does no work");
}
process.env.CRON_SECRET = savedSecret;

// Successful observation.
reset();
const before = Date.now();
let response = await call();
let result = await body(response);
assert(response.status === 200 && result.outcome === "succeeded", "authorized call observes");
assert(response.headers.get("cache-control") === "no-store", "observe response is not cached");
assert(rows.length === 1 && calls.orbio === 1, "one row, one Orbio read");
let row = rows[0];
assert(row.slot_start === result.slotStart, "response names the slot");
assert(row.cadence_seconds === 300, "row records the cadence");
const slotMs = Date.parse(row.slot_start);
const attemptedMs = Date.parse(row.attempted_at);
assert(slotMs % 300_000 === 0, "slot is on a 5-minute boundary");
assert(slotMs <= attemptedMs && attemptedMs < slotMs + 300_000, "slot is the open slot, never a future one");
assert(attemptedMs >= before - 1, "attempted_at is the actual attempt time");
assert(row.outcome === "succeeded" && row.completed_at != null, "row completed as succeeded");
assert(
  JSON.stringify(row.levels) ===
    JSON.stringify([
      { discount_bps: 3000, credit_atoms: 71804922 },
      { discount_bps: 2750, credit_atoms: 31587333 },
      { discount_bps: 2500, credit_atoms: 11815216096 },
    ]),
  "levels stored as exact atoms",
);
assert(row.min_buy_credit_atoms === 5_000_000, "minimum buy stored");
assert(row.reported_total_credit_atoms === 11_918_608_351, "reported total stored");
assert(row.fingerprint === live.fingerprint, "fingerprint stored");

// A second call in the same slot is a duplicate and does not read Orbio.
const snapshot = JSON.stringify(rows);
response = await call();
result = await body(response);
assert(response.status === 200 && result.status === "duplicate", "same slot is a duplicate");
assert(calls.orbio === 1 && JSON.stringify(rows) === snapshot, "duplicate leaves Orbio and the row alone");

// Overlapping calls: one claim wins, one Orbio read.
{
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  reset(async () => {
    await gate;
    return json(liveBook);
  });
  const first = call();
  const second = call();
  const third = call();
  await new Promise((resolve) => setTimeout(resolve, 20));
  release?.();
  const results = await Promise.all([first, second, third].map(async (p) => body(await p)));
  assert(calls.orbio === 1, "overlapping calls read Orbio once");
  assert(rows.length === 1 && rows[0].outcome === "succeeded", "overlapping calls store one observation");
  assert(results.filter((r) => r.status === "duplicate").length === 2, "the other calls are duplicates");
}

// Handled failures: 200, recorded, no market state, no retry within the slot.
for (const [label, handler, outcome, httpStatus] of [
  ["429", async () => new Response("slow down", { status: 429 }), "http_error", 429],
  ["503", async () => new Response("down", { status: 503 }), "http_error", 503],
  ["404", async () => new Response("gone", { status: 404 }), "http_error", 404],
  ["malformed", async () => json({ rows: [{ discountBps: 2500, microUsd: "x" }] }), "invalid_payload", null],
  ["non-JSON", async () => new Response("<html>"), "invalid_payload", null],
  ["network", async () => { throw new TypeError("fetch failed"); }, "network", null],
  ["timeout", async () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); }, "timeout", null],
] as [string, OrbioHandler, string, number | null][]) {
  reset(handler);
  response = await call();
  result = await body(response);
  assert(response.status === 200 && result.outcome === outcome, `${label}: handled 200 with ${outcome}`);
  row = rows[0];
  assert(rows.length === 1 && row.outcome === outcome, `${label}: recorded as ${outcome}`);
  assert(row.http_status === httpStatus, `${label}: http_status recorded`);
  assert(row.levels === null && row.fingerprint === null, `${label}: no market state`);
  assert(typeof row.error_detail === "string" && row.error_detail.length > 0, `${label}: detail recorded`);
  const retry = await body(await call());
  assert(retry.status === "duplicate" && calls.orbio === 1, `${label}: slot is not retried`);
}

// Empty book is a successful observation.
reset(async () => json({ rows: [], totalMicroUsd: "0", minBuyMicroUsd: "5000000" }));
result = await body(await call());
assert(result.outcome === "succeeded", "empty book succeeds");
assert(Array.isArray(rows[0].levels) && rows[0].levels.length === 0, "empty book stores no levels");
assert(rows[0].fingerprint === empty.fingerprint, "empty book stores its fingerprint");

// Missing minimum and total are stored as null.
reset(async () => json({ rows: liveBook.rows }));
result = await body(await call());
assert(result.outcome === "succeeded", "book without minimum or total succeeds");
assert(rows[0].min_buy_credit_atoms === null && rows[0].reported_total_credit_atoms === null, "missing fields stored as null");

// Database cannot claim: 500 and Orbio is not read.
reset();
db.failInsert = true;
response = await call();
assert(response.status === 500, "claim failure is a 500");
assert(calls.orbio === 0 && rows.length === 0, "claim failure does not read Orbio");

// Database cannot complete: 500 and the row stays incomplete without market state.
reset();
db.failUpdate = true;
response = await call();
assert(response.status === 500, "write failure is a 500");
row = rows[0];
assert(rows.length === 1 && row.outcome === "incomplete" && row.completed_at === null, "row stays incomplete");
assert(row.levels === null && row.fingerprint === null, "incomplete row carries no market state");
db.failUpdate = false;
result = await body(await call());
assert(result.status === "duplicate" && calls.orbio === 1, "incomplete slot is not retried");

// Configured cadence.
reset();
process.env.OBSERVATION_CADENCE_SECONDS = "60";
result = await body(await call());
assert(result.outcome === "succeeded" && rows[0].cadence_seconds === 60, "configured cadence is recorded");
assert(Date.parse(rows[0].slot_start) % 60_000 === 0, "slot aligned to configured cadence");

reset();
process.env.OBSERVATION_CADENCE_SECONDS = "420";
result = await body(await call());
assert(result.outcome === "succeeded" && rows[0].cadence_seconds === 420, "non-dividing cadence is recorded");
assert(Date.parse(rows[0].slot_start) % 420_000 === 0, "slot floors to the configured cadence");

reset();
process.env.OBSERVATION_CADENCE_SECONDS = "0";
response = await call();
result = await body(response);
assert(response.status === 503 && result.error === "Market observation is misconfigured.", "invalid cadence is a configuration error");
assert(calls.claims === 0 && calls.orbio === 0, "invalid cadence does no work");
delete process.env.OBSERVATION_CADENCE_SECONDS;

// ---------------------------------------------------------------------------
// Isolation from procurement, execution, wallet, and History code.
// ---------------------------------------------------------------------------

const FORBIDDEN = [
  "/market\"",
  "exchange",
  "receipt",
  "decision",
  "evaluation",
  "quote",
  "reason",
  "record",
  "outcomes",
  "performance",
  "history",
  "wallet",
  "/store\"",
  "/rows\"",
  "types/ora",
];
for (const path of [
  "../../app/api/observe/route.ts",
  "./book-observation.ts",
  "../db/observations.ts",
]) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const imports = source.match(/from\s+"[^"]+"/g) ?? [];
  for (const statement of imports) {
    for (const name of FORBIDDEN) {
      assert(!statement.includes(name), `${path} must not import ${statement}`);
    }
  }
}

console.log("book-observation checks passed");
