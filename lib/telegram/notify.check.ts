process.env.SUPABASE_URL = "http://supabase.test";
process.env.SUPABASE_SECRET_KEY = "test-secret";
process.env.ROBINHOOD_RPC_URL = "http://rpc.test";
process.env.ORBIO_MARKET_ORIGIN = "http://orbio.test";
process.env.NEXT_PUBLIC_APP_URL = "https://www.useora.site";
process.env.CRON_SECRET = "cron-test-secret";
process.env.TELEGRAM_BOT_USERNAME = "OraAlertsBot";
process.env.TELEGRAM_WEBHOOK_SECRET = "test_webhook_secret_0123456789abcdef";
const BOT_TOKEN = "123456789:AAtestTokenValue_abcdefghijklmnopqrstu";
process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
process.env.TELEGRAM_ALERTS_ENABLED = "true";

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { TargetAlertRow } from "../db/alerts";
import type { TelegramLinkRow } from "../db/telegram";
import type { TargetRow } from "../db/targets";

const { deliverTelegramNotifications, openOraUrl, sameReadyPeriod, MAX_SENDS_PER_RUN } = await import(
  "./notify"
);
const { claimTelegramAlert, MAX_ALERT_ATTEMPTS } = await import("../db/alert-delivery");
const observeRoute = await import("../../app/api/observe/route");

function assert(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}

async function check(label: string, run: () => Promise<void> | void) {
  await run();
  console.log(`ok - ${label}`);
}

// ---------------------------------------------------------------------------
// Captured logs: the bot token must never appear.
// ---------------------------------------------------------------------------

const logged: string[] = [];
for (const level of ["log", "info", "warn", "error"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    if (level === "log") original(...args);
  };
}

// ---------------------------------------------------------------------------
// Fake backend.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

let targets: TargetRow[] = [];
let alerts: TargetAlertRow[] = [];
let links: TelegramLinkRow[] = [];
let observations: Row[] = [];
let sends: { url: string; body: Record<string, unknown> }[] = [];
let telegram: (body: Record<string, unknown>, signal?: AbortSignal | null) => Promise<Response> =
  async () => json({ ok: true, result: { message_id: 4242 } });
let supabaseCalls = 0;
let failAlertReads = false;
let listBarrier: { size: number; waiting: (() => void)[] } | null = null;
let orbioBookStatus = 500;

const sendCount = () => sends.length;
const alertById = (id: string) => alerts.find((row) => row.id === id)!;
const linkFor = (wallet: string) => links.find((row) => row.wallet_address === wallet)!;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function compare(value: unknown, arg: string): number {
  const a = Date.parse(String(value));
  const b = Date.parse(arg);
  if (Number.isFinite(a) && Number.isFinite(b) && /\d{4}-\d{2}-\d{2}/.test(arg)) return a - b;
  return Number(value) - Number(arg);
}

function matches(row: Row, column: string, expr: string): boolean {
  const value = row[column];
  if (expr === "is.null") return value == null;
  if (expr === "not.is.null") return value != null;
  const dot = expr.indexOf(".");
  const op = expr.slice(0, dot);
  const arg = expr.slice(dot + 1);
  if (op === "eq") return value != null && String(value) === arg;
  if (op === "in") return arg.replace(/^\(|\)$/g, "").split(",").includes(String(value));
  if (op === "lt") return value != null && compare(value, arg) < 0;
  if (op === "lte") return value != null && compare(value, arg) <= 0;
  if (op === "gt") return value != null && compare(value, arg) > 0;
  throw new Error(`fake postgrest: unsupported filter ${column}=${expr}`);
}

const CONTROL_PARAMS = new Set(["select", "order", "limit", "on_conflict", "columns"]);

function query<T extends Row>(rows: T[], url: URL): T[] {
  let found = rows.filter((row) =>
    [...url.searchParams].every(([key, expr]) => CONTROL_PARAMS.has(key) || matches(row, key, expr)),
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
  if (rows.length !== 1) return json({ code: "PGRST116", message: "not one row" }, 406);
  return json(rows[0], status);
}

/** Mirrors target_alerts check constraints. */
function alertViolation(row: TargetAlertRow): string | null {
  const statuses = ["pending", "sending", "sent", "failed_retryable", "failed_permanent", "unknown", "skipped", "suppressed"];
  if (!statuses.includes(row.status)) return "status_check";
  if (row.attempts < 0) return "attempts_check";
  if ((row.status === "sent") !== (row.sent_at != null)) return "sent_check";
  return null;
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const method = (init?.method ?? "GET").toUpperCase();

  if (url.host === "api.telegram.org") {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    sends.push({ url: url.href, body });
    return telegram(body, init?.signal);
  }
  if (url.host === "orbio.test") return json({ error: "down" }, orbioBookStatus);
  if (url.host !== "supabase.test") throw new Error(`unexpected outbound request to ${url.host}`);
  supabaseCalls += 1;

  if (url.pathname === "/rest/v1/procurement_targets" && method === "GET") {
    return respondRows(query(targets, url), init);
  }

  if (url.pathname === "/rest/v1/target_alerts") {
    if (failAlertReads) return json({ code: "XX000", message: "alerts unavailable" }, 500);
    if (method === "GET") {
      const rows = query(alerts, url).map((row) => ({ ...row }));
      if (listBarrier && url.searchParams.get("status") === "eq.pending") {
        const barrier = listBarrier;
        await new Promise<void>((resolve) => {
          barrier.waiting.push(resolve);
          if (barrier.waiting.length >= barrier.size) barrier.waiting.forEach((release) => release());
        });
      }
      return respondRows(rows, init);
    }
    if (method === "PATCH") {
      const found = query(alerts, url);
      const patch = JSON.parse(String(init?.body)) as Partial<TargetAlertRow>;
      for (const row of found) {
        const violation = alertViolation({ ...row, ...patch });
        if (violation) return json({ code: "23514", message: violation }, 400);
      }
      for (const row of found) Object.assign(row, patch);
      return respondRows(found, init);
    }
  }

  if (url.pathname === "/rest/v1/telegram_links") {
    if (method === "GET") return respondRows(query(links, url), init);
    if (method === "PATCH") {
      const found = query(links, url);
      const patch = JSON.parse(String(init?.body)) as Partial<TelegramLinkRow>;
      for (const row of found) Object.assign(row, patch);
      return respondRows(found, init);
    }
  }

  if (url.pathname === "/rest/v1/market_observations") {
    if (method === "POST") {
      const body = JSON.parse(String(init?.body)) as Row;
      if (observations.some((row) => row.slot_start === body.slot_start)) return respondRows([], init, 201);
      observations.push(body);
      return respondRows([body], init, 201);
    }
    if (method === "PATCH") {
      const found = query(observations, url);
      const patch = JSON.parse(String(init?.body)) as Row;
      for (const row of found) Object.assign(row, patch);
      return respondRows(found, init);
    }
  }

  throw new Error(`fake backend: unexpected ${method} ${url.pathname}`);
}) as typeof fetch;

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

const READY_SINCE = "2026-10-06T09:40:03.123456+00:00";
const QUOTED_AT = "2026-10-06T09:41:12.000+00:00";

function wallet(n: number): string {
  return `0x${n.toString(16).padStart(40, "a")}`;
}

function seed(n: number, overrides: { target?: Partial<TargetRow>; alert?: Partial<TargetAlertRow>; link?: Partial<TelegramLinkRow> | null } = {}) {
  const w = wallet(n);
  const target: TargetRow = {
    id: `target-${n}-7f3a`,
    wallet_address: w,
    requested_credit: 50,
    min_discount_percent: 20,
    max_spend_usdg: 40,
    status: "READY",
    created_at: "2026-10-06T08:00:00.000+00:00",
    updated_at: QUOTED_AT,
    cancelled_at: null,
    fulfilled_at: null,
    active_decision_id: `decision-${n}-9c1e`,
    fulfilled_decision_id: null,
    last_evaluated_at: QUOTED_AT,
    last_evaluation_action: "BUY",
    last_evaluation_reason: "qualifies",
    last_requested_amount: 50,
    last_executable_discount_percent: 21.4,
    last_executable_total_usdg: 39.3,
    ready_since: READY_SINCE,
    ...overrides.target,
  };
  const alert: TargetAlertRow = {
    id: `alert-${n}-b2d4`,
    target_id: target.id,
    wallet_address: w,
    channel: "telegram",
    ready_since: READY_SINCE,
    status: "pending",
    attempts: 0,
    next_attempt_at: null,
    claimed_at: null,
    sent_at: null,
    telegram_message_id: null,
    last_error: null,
    created_at: `2026-10-06T09:40:04.${String(n).padStart(3, "0")}+00:00`,
    ...overrides.alert,
  };
  targets.push(target);
  alerts.push(alert);
  if (overrides.link !== null) {
    links.push({
      wallet_address: w,
      telegram_user_id: 777_000_100 + n,
      telegram_chat_id: 777_000_100 + n,
      linked_at: "2026-10-06T04:14:40.044+00:00",
      disabled_at: null,
      disabled_reason: null,
      created_at: "2026-10-06T04:14:40.813+00:00",
      updated_at: "2026-10-06T04:14:40.044+00:00",
      ...overrides.link,
    });
  }
  return { target, alert, wallet: w, chatId: 777_000_100 + n };
}

function reset() {
  targets = [];
  alerts = [];
  links = [];
  observations = [];
  sends = [];
  supabaseCalls = 0;
  failAlertReads = false;
  listBarrier = null;
  telegram = async () => json({ ok: true, result: { message_id: 4242 } });
}

const run = (deadlineMs = 20_000) => deliverTelegramNotifications({ deadline: Date.now() + deadlineMs });

const EXPECTED_TEXT = [
  "Ora — procurement target READY",
  "",
  "Requested: 50 CREDIT",
  "Executable discount: 21.4%",
  "Quoted cost: 39.30 USDG (quoted 09:41 UTC)",
  "",
  "Nothing has been purchased. Prices can change.",
  "",
  "Open Ora to re-check the market and review. Ora never buys without your wallet signature.",
].join("\n");

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

let sentFixture: ReturnType<typeof seed>;

await check("1. eligible pending alert sends successfully", async () => {
  reset();
  sentFixture = seed(1);
  const result = await run();
  assert(result.status === "ran" && result.results[0]?.outcome === "sent", `sent (${JSON.stringify(result)})`);
  assert(sendCount() === 1, "exactly one sendMessage");
  assert(sends[0].url === `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, "sendMessage endpoint");
  assert(sends[0].body.chat_id === sentFixture.chatId, "sent to the linked chat");
});

await check("2. successful send becomes sent", () => {
  const row = alertById(sentFixture.alert.id);
  assert(row.status === "sent" && row.attempts === 1 && row.last_error == null, "status sent");
});

await check("3. Telegram message ID is stored", () => {
  assert(alertById(sentFixture.alert.id).telegram_message_id === 4242, "message id stored");
});

await check("4. sent timestamp is stored", () => {
  const row = alertById(sentFixture.alert.id);
  assert(row.sent_at && Math.abs(Date.parse(row.sent_at) - Date.now()) < 10_000, "sent_at stored");
  assert(row.claimed_at && Date.parse(row.claimed_at) <= Date.parse(row.sent_at), "claimed before sent");
});

await check("5. pre-delivery pending alerts are skipped by the migration only", () => {
  const sql = readFileSync(join("supabase", "migrations", "20261006060000_skip_pre_delivery_alerts.sql"), "utf8").replace(/\r\n/g, "\n");
  const predicate =
    "where status = 'pending'\n    and attempts = 0\n    and claimed_at is null\n    and sent_at is null\n    and created_at < timestamptz '2026-10-06 00:00:00+00'";
  assert(sql.split(predicate).length === 3, "count and update use the same fixed predicate");
  assert(sql.includes("set status = 'skipped',\n      last_error = 'created_before_telegram_delivery_enabled'"), "skip reason");
  assert(sql.includes("if stale_count > 2 then\n    raise exception"), "aborts if more than the two known rows match");
  assert(!/\bdelete\b|procurement_targets|now\(\)|interval/i.test(sql.replace(/^--.*$/gm, "")), "no delete, no target writes, no relative age");
  const skipped = { ...seed(50, { alert: { status: "skipped", last_error: "created_before_telegram_delivery_enabled" } }) };
  return run().then(() => {
    assert(alertById(skipped.alert.id).status === "skipped" && sends.every((s) => s.body.chat_id !== skipped.chatId), "skipped row never sent");
  });
});

await check("6. stale READY period is not sent", async () => {
  reset();
  const f = seed(2, { target: { ready_since: "2026-10-06T10:20:03.000001+00:00" } });
  const result = await run();
  assert(sendCount() === 0, "no send");
  assert(alertById(f.alert.id).status === "skipped" && alertById(f.alert.id).last_error === "stale_ready_period", "skipped stale period");
  assert(result.status === "ran" && result.results[0].reason === "stale_ready_period", "reason reported");
  assert(sameReadyPeriod("2026-10-06T09:40:03.123456+00:00", "2026-10-06T09:40:03.123456Z"), "same instant, other format");
  assert(!sameReadyPeriod("2026-10-06T09:40:03.123456+00:00", "2026-10-06T09:40:03.123457+00:00"), "microsecond difference is a new period");
  assert(!sameReadyPeriod(READY_SINCE, undefined), "no period");
});

await check("7. target no longer READY is not sent", async () => {
  reset();
  const cases = [
    seed(3, { target: { status: "WATCHING", ready_since: null } }),
    seed(4, { target: { status: "CANCELLED", ready_since: null, cancelled_at: QUOTED_AT } }),
    seed(5, { target: { status: "FULFILLED", ready_since: null, fulfilled_at: QUOTED_AT } }),
  ];
  const missing = seed(6);
  targets = targets.filter((t) => t.id !== missing.target.id);
  await run();
  assert(sendCount() === 0, "no sends");
  assert(alertById(cases[0].alert.id).last_error === "target_watching", "watching");
  assert(alertById(cases[1].alert.id).last_error === "target_cancelled", "cancelled");
  assert(alertById(cases[2].alert.id).last_error === "target_fulfilled", "fulfilled");
  assert(alertById(missing.alert.id).last_error === "target_missing", "missing target");
  assert(alerts.every((a) => a.status === "skipped"), "all skipped");
});

await check("8. wallet mismatch is not sent", async () => {
  reset();
  const f = seed(7, { alert: { wallet_address: wallet(99) } });
  links.push({ ...linkFor(f.wallet), wallet_address: wallet(99), telegram_chat_id: 1, telegram_user_id: 1 });
  await run();
  assert(sendCount() === 0, "no send");
  assert(alertById(f.alert.id).status === "skipped" && alertById(f.alert.id).last_error === "wallet_mismatch", "wallet mismatch");
});

await check("9. disabled Telegram link is not sent", async () => {
  reset();
  const disabled = seed(8, { link: { disabled_at: QUOTED_AT, disabled_reason: "user_requested" } });
  const none = seed(9, { link: null });
  await run();
  assert(sendCount() === 0, "no send");
  assert(alertById(disabled.alert.id).last_error === "no_active_telegram_link", "disabled link skipped");
  assert(alertById(none.alert.id).last_error === "no_active_telegram_link", "unlinked wallet skipped");
});

await check("10. duplicate concurrent delivery attempts result in only one send", async () => {
  reset();
  const f = seed(10);
  listBarrier = { size: 2, waiting: [] };
  const [a, b] = await Promise.all([run(), run()]);
  listBarrier = null;
  const outcomes = [a, b].flatMap((r) => (r.status === "ran" ? r.results.map((x) => x.outcome) : []));
  assert(outcomes.sort().join(",") === "claimed_elsewhere,sent", `one winner (${outcomes.join(",")})`);
  assert(sendCount() === 1 && alertById(f.alert.id).status === "sent" && alertById(f.alert.id).attempts === 1, "single send");

  reset();
  const g = seed(11);
  const snapshot = { ...g.alert };
  const claims = await Promise.all([1, 2, 3].map(() => claimTelegramAlert(snapshot, new Date())));
  assert(claims.filter(Boolean).length === 1, "only one claim succeeds");
  assert(alertById(g.alert.id).status === "sending", "claimed row is sending");
  await run();
  assert(sendCount() === 0, "a claimed (sending) alert is not sent by another run");
});

await check("11. HTTP 429 becomes retryable and is not retried in the same request", async () => {
  reset();
  const first = seed(12);
  const second = seed(13);
  telegram = async () => json({ ok: false, error_code: 429, description: "Too Many Requests: retry after 120", parameters: { retry_after: 120 } }, 429);
  const before = Date.now();
  const result = await run();
  const row = alertById(first.alert.id);
  assert(row.status === "failed_retryable" && row.attempts === 1 && row.last_error === "telegram_429", "retryable");
  const wait = Date.parse(row.next_attempt_at!) - before;
  assert(wait >= 120_000 && wait < 130_000, `next_attempt_at honors retry_after (${wait})`);
  assert(sendCount() === 1 && alertById(second.alert.id).status === "pending", "run stops after a rate limit");
  assert(result.status === "ran" && result.stoppedEarly, "stopped early");
});

await check("12. HTTP 5xx becomes retryable", async () => {
  reset();
  const f = seed(14);
  telegram = async () => json({ ok: false, description: "Bad Gateway" }, 502);
  const before = Date.now();
  await run();
  const row = alertById(f.alert.id);
  assert(row.status === "failed_retryable" && row.last_error === "telegram_502", "retryable 5xx");
  const wait = Date.parse(row.next_attempt_at!) - before;
  assert(wait >= 60_000 && wait < 70_000, `bounded first backoff (${wait})`);
});

await check("13. HTTP 400 becomes permanent failure", async () => {
  reset();
  const malformed = seed(15);
  telegram = async () => json({ ok: false, description: "Bad Request: message text is empty" }, 400);
  await run();
  const row = alertById(malformed.alert.id);
  assert(row.status === "failed_permanent" && row.last_error === "telegram_400: Bad Request: message text is empty", "permanent");
  assert(linkFor(malformed.wallet).disabled_at == null, "malformed request keeps the link");

  reset();
  const gone = seed(16);
  telegram = async () => json({ ok: false, description: "Bad Request: chat not found" }, 400);
  await run();
  assert(alertById(gone.alert.id).status === "failed_permanent", "chat not found permanent");
  const link = linkFor(gone.wallet);
  assert(link.disabled_at != null && link.disabled_reason === "telegram_unreachable", "unusable chat link disabled");
});

await check("14. HTTP 403 becomes permanent failure and disables only that link", async () => {
  reset();
  const blocked = seed(17);
  const other = seed(18);
  let call = 0;
  telegram = async () => (++call === 1 ? json({ ok: false, description: "Forbidden: bot was blocked by the user" }, 403) : json({ ok: true, result: { message_id: 7 } }));
  await run();
  assert(alertById(blocked.alert.id).status === "failed_permanent", "permanent");
  assert(linkFor(blocked.wallet).disabled_reason === "telegram_unreachable", "blocked link disabled");
  assert(linkFor(other.wallet).disabled_at == null && alertById(other.alert.id).status === "sent", "other wallet unaffected");
  await run();
  assert(sendCount() === 2, "permanent failure never retried");
});

await check("15. timeout becomes unknown", async () => {
  reset();
  const f = seed(19);
  telegram = (_body, signal) =>
    new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
  const started = Date.now();
  await run();
  const elapsed = Date.now() - started;
  assert(alertById(f.alert.id).status === "unknown" && alertById(f.alert.id).last_error === "telegram_timeout", "timeout unknown");
  assert(elapsed >= 2_900 && elapsed < 6_000, `3 second send timeout (${elapsed})`);

  reset();
  const g = seed(20);
  telegram = async () => {
    throw new TypeError("fetch failed");
  };
  await run();
  assert(alertById(g.alert.id).status === "unknown" && alertById(g.alert.id).last_error === "telegram_network", "network unknown");
});

await check("16. unknown is not automatically retried", async () => {
  const before = sendCount();
  telegram = async () => json({ ok: true, result: { message_id: 1 } });
  await run();
  await run();
  assert(sendCount() === before, "no resend after unknown");

  reset();
  const interrupted = seed(21, {
    alert: { status: "sending", attempts: 1, claimed_at: new Date(Date.now() - 6 * 60_000).toISOString() },
  });
  const fresh = seed(22, { alert: { status: "sending", attempts: 1, claimed_at: new Date().toISOString() } });
  await run();
  assert(alertById(interrupted.alert.id).status === "unknown" && alertById(interrupted.alert.id).last_error === "send_interrupted", "interrupted claim becomes unknown");
  assert(alertById(fresh.alert.id).status === "sending", "in-progress claim untouched");
  assert(sendCount() === 0, "neither is resent");
});

await check("17. retryable failures respect next_attempt_at", async () => {
  reset();
  const f = seed(23);
  telegram = async () => json({ ok: false }, 503);
  await run();
  assert(alertById(f.alert.id).status === "failed_retryable" && sendCount() === 1, "first failure");
  telegram = async () => json({ ok: true, result: { message_id: 99 } });
  await run();
  assert(sendCount() === 1, "not retried before next_attempt_at");
  alertById(f.alert.id).next_attempt_at = new Date(Date.now() - 1_000).toISOString();
  await run();
  const row = alertById(f.alert.id);
  assert(sendCount() === 2 && row.status === "sent" && row.attempts === 2 && row.telegram_message_id === 99, "retried once due");
});

await check("18. maximum 3 attempts enforced", async () => {
  reset();
  const f = seed(24);
  telegram = async () => json({ ok: false }, 500);
  for (let attempt = 1; attempt <= MAX_ALERT_ATTEMPTS + 2; attempt += 1) {
    const row = alertById(f.alert.id);
    if (row.next_attempt_at) row.next_attempt_at = new Date(Date.now() - 1_000).toISOString();
    await run();
  }
  const row = alertById(f.alert.id);
  assert(MAX_ALERT_ATTEMPTS === 3 && sendCount() === 3, `three sends total (${sendCount()})`);
  assert(row.status === "failed_permanent" && row.attempts === 3, "permanent after the third");
  assert(row.last_error === "telegram_500; max_attempts_reached", "reason recorded");

  reset();
  const exhausted = seed(25, { alert: { status: "failed_retryable", attempts: 3, next_attempt_at: new Date(0).toISOString() } });
  await run();
  assert(sendCount() === 0 && alertById(exhausted.alert.id).status === "failed_retryable", "exhausted retryable row is never claimed");
});

await check("19. suppressed alerts are never sent", async () => {
  reset();
  const f = seed(26, { alert: { status: "suppressed" } });
  await run();
  assert(sendCount() === 0 && alertById(f.alert.id).status === "suppressed", "suppressed untouched");
});

await check("20. skipped, sent, permanent and unknown alerts are never sent", async () => {
  reset();
  const rows = [
    seed(27, { alert: { status: "skipped", last_error: "created_before_telegram_delivery_enabled" } }),
    seed(28, { alert: { status: "sent", attempts: 1, sent_at: QUOTED_AT, telegram_message_id: 5 } }),
    seed(29, { alert: { status: "failed_permanent", attempts: 1 } }),
    seed(30, { alert: { status: "unknown", attempts: 1 } }),
  ];
  const before = JSON.stringify(alerts);
  await run();
  await run();
  assert(sendCount() === 0, "no sends");
  assert(JSON.stringify(alerts) === before && rows.length === 4, "rows unchanged");
});

let deliveredBody: Record<string, unknown> = {};

await check("21. message contains no wallet address or internal IDs", async () => {
  reset();
  const f = seed(31);
  await run();
  deliveredBody = sends[0].body;
  const { chat_id: _chat, ...visible } = deliveredBody;
  const rendered = JSON.stringify(visible).toLowerCase();
  const link = linkFor(f.wallet);
  for (const secret of [
    f.wallet,
    f.target.id,
    f.alert.id,
    String(f.target.active_decision_id),
    String(link.telegram_chat_id),
    String(link.telegram_user_id),
    "0x",
    BOT_TOKEN,
  ]) {
    assert(!rendered.includes(secret.toLowerCase()), `message leaks nothing (${secret.slice(0, 8)})`);
  }
  assert(Object.keys(deliveredBody).sort().join(",") === "chat_id,link_preview_options,reply_markup,text", "only expected fields");
  assert(deliveredBody.text === EXPECTED_TEXT, `exact message:\n${String(deliveredBody.text)}`);
});

await check("22. message contains the correct requested CREDIT", () => {
  assert(String(deliveredBody.text).includes("\nRequested: 50 CREDIT\n"), "requested");
});

await check("23. message contains the correct executable discount", () => {
  assert(String(deliveredBody.text).includes("\nExecutable discount: 21.4%\n"), "discount");
});

await check("24. message contains the correct quoted cost", async () => {
  assert(String(deliveredBody.text).includes("\nQuoted cost: 39.30 USDG (quoted 09:41 UTC)\n"), "cost and time");
  reset();
  seed(32, {
    target: {
      last_requested_amount: 125,
      last_executable_discount_percent: 18.75,
      last_executable_total_usdg: 101.5625,
      last_evaluated_at: "2026-10-06T23:05:59.999+00:00",
    },
  });
  await run();
  const text = String(sends[0].body.text);
  assert(text.includes("Requested: 125 CREDIT") && text.includes("Executable discount: 18.75%") && text.includes("Quoted cost: 101.56 USDG (quoted 23:05 UTC)"), `values from target data:\n${text}`);
  reset();
  const incomplete = seed(33, { target: { last_executable_total_usdg: null } });
  await run();
  assert(sendCount() === 0 && alertById(incomplete.alert.id).last_error === "missing_quote_facts", "no fabricated values");
});

await check("25. Open Ora button points to NEXT_PUBLIC_APP_URL/app#targets", () => {
  const markup = deliveredBody.reply_markup as { inline_keyboard: { text: string; url: string }[][] };
  assert(markup.inline_keyboard.length === 1 && markup.inline_keyboard[0].length === 1, "exactly one button");
  const button = markup.inline_keyboard[0][0];
  assert(button.text === "Open Ora", "button text");
  assert(button.url === "https://www.useora.site/app#targets" && openOraUrl() === button.url, `button url ${button.url}`);
  assert(Object.keys(button).sort().join(",") === "text,url", "URL button only, no callback data");
});

await check("26. no token, target or decision identifier appears in the URL", () => {
  const markup = deliveredBody.reply_markup as { inline_keyboard: { url: string }[][] };
  const url = new URL(markup.inline_keyboard[0][0].url);
  assert(url.search === "" && url.hash === "#targets" && url.pathname === "/app", "fixed path, no query");
  assert(!/target-|alert-|decision-|0x|start=/.test(url.href), "no identifiers");
});

await check("27. Telegram delivery failure does not fail /api/observe", async () => {
  const observe = (auth = "Bearer cron-test-secret") =>
    observeRoute.GET(new Request("https://www.useora.site/api/observe", { headers: { authorization: auth } }));

  reset();
  const f = seed(34);
  telegram = async () => {
    throw new TypeError("fetch failed");
  };
  const response = await observe();
  const body = (await response.json()) as Record<string, unknown>;
  assert(response.status === 200 && body.outcome === "http_error", `observation recorded (${JSON.stringify(body)})`);
  assert(observations.length === 1 && observations[0].outcome === "http_error", "observation row completed");
  assert(alertById(f.alert.id).status === "unknown" && sendCount() === 1, "delivery ran once and failed safely");

  reset();
  seed(35);
  failAlertReads = true;
  const broken = await observe();
  assert(broken.status === 200 && sendCount() === 0, "alert storage failure does not fail the observation");

  reset();
  seed(36);
  const duplicate = await observe();
  const again = await observe();
  assert(duplicate.status === 200 && again.status === 200 && sendCount() === 1, "duplicate slot invocation sends nothing");
  assert((await observe("Bearer wrong")).status === 401 && sendCount() === 1, "unauthorized observe sends nothing");
});

await check("delivery fails closed when disabled or misconfigured", async () => {
  reset();
  seed(37);
  for (const value of [undefined, "", "false", "0", "yes", "TRUE "]) {
    if (value === undefined) delete process.env.TELEGRAM_ALERTS_ENABLED;
    else process.env.TELEGRAM_ALERTS_ENABLED = value;
    const result = await run();
    const expected = value?.trim().toLowerCase() === "true" ? "ran" : "disabled";
    assert(result.status === expected, `TELEGRAM_ALERTS_ENABLED=${String(value)} -> ${result.status}`);
    if (expected === "ran") {
      reset();
      seed(37);
    }
  }
  process.env.TELEGRAM_ALERTS_ENABLED = "false";
  const callsBefore = supabaseCalls;
  await run();
  assert(supabaseCalls === callsBefore && sendCount() === 0, "disabled delivery touches nothing");
  process.env.TELEGRAM_ALERTS_ENABLED = "true";
  for (const token of [undefined, "", "not-a-token"]) {
    if (token === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = token;
    const result = await run();
    assert(result.status === "misconfigured" && sendCount() === 0, "missing token fails closed");
  }
  process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
});

await check("send budget and deadline are bounded", async () => {
  reset();
  for (let n = 40; n < 40 + MAX_SENDS_PER_RUN + 2; n += 1) seed(n);
  const result = await run();
  assert(MAX_SENDS_PER_RUN === 10 && sendCount() === 10, `at most 10 sends (${sendCount()})`);
  assert(result.status === "ran" && result.results.length === 10, "ten results");
  await run();
  assert(sendCount() === 12, "remaining alerts go out on the next observation");

  reset();
  seed(60);
  const late = await deliverTelegramNotifications({ deadline: Date.now() + 2_000 });
  assert(late.status === "ran" && late.stoppedEarly && sendCount() === 0, "stops when the route budget is too small");
  assert(alerts[0].status === "pending", "unattempted alert stays pending");
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : [path];
  });
}

await check("28. no page-load or review path can trigger delivery", () => {
  const callers = [...sourceFiles("app"), ...sourceFiles("lib"), ...sourceFiles("components")]
    .filter((path) => /\.(ts|tsx)$/.test(path) && !path.endsWith(".check.ts"))
    .filter((path) => {
      const source = readFileSync(path, "utf8");
      return /deliverTelegramNotifications|telegram\/notify|sendTelegramMessage|claimTelegramAlert/.test(source);
    })
    .map((path) => path.replace(/\\/g, "/"))
    .sort();
  assert(
    callers.join(",") ===
      "app/api/observe/route.ts,lib/db/alert-delivery.ts,lib/telegram/notify.ts,lib/telegram/send.ts",
    `only the scheduler route reaches delivery (${callers.join(",")})`,
  );
  const sender = readFileSync(join("lib", "telegram", "send.ts"), "utf8");
  assert(
    (sender.match(/\/bot\$\{token\}\/\w+/g) ?? []).join(",") === "/bot${token}/sendMessage" &&
      !/getUpdates|setWebhook/.test(sender),
    "one Bot API method",
  );
  const notify = readFileSync(join("lib", "telegram", "notify.ts"), "utf8");
  for (const forbidden of ["quoteForCredit", "persistTargetEvaluation", "appendDecision", "updateOwnedDecision", "insertTargetAlert", "execute/", "signMessage", "callback_data"]) {
    assert(!notify.includes(forbidden), `delivery does not reference ${forbidden}`);
  }
});

await check("logs never contain the bot token or webhook secret", () => {
  const all = logged.join("\n");
  assert(!all.includes(BOT_TOKEN) && !all.includes(BOT_TOKEN.split(":")[1]), "token never logged");
  assert(!all.includes(String(process.env.TELEGRAM_WEBHOOK_SECRET)), "secret never logged");
  assert(!all.includes("777000"), "chat ids never logged");
});

console.log("\ntelegram delivery checks passed");
