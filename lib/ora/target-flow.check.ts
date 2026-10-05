process.env.SUPABASE_URL = "http://supabase.test";
process.env.SUPABASE_SECRET_KEY = "test-secret";
process.env.ROBINHOOD_RPC_URL = "http://rpc.test";
process.env.ORBIO_MARKET_ORIGIN = "http://orbio.test";
process.env.CRON_SECRET = "test-cron-secret";

import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  encodeFunctionResult,
  parseAbiItem,
  type Hex,
} from "viem";
import type { DecisionRow } from "../db/rows";
import type { TargetRow } from "../db/targets";
import type {
  ExecutableQuote,
  ExecutionStatus,
  MarketSnapshot,
  ProcurementTarget,
} from "../../types/ora";

const { beneficiaryBytes32, exchangeAbi } = await import("../orbio/exchange");
const { CONTRACTS } = await import("../orbio/contracts");
const { fulfillTargetFromDecision, persistTargetEvaluation, requireOwnedTarget } =
  await import("../db/targets");
const { evaluateTarget, marketSnapshotFromObservedBook } = await import("./target");

function assert(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}

const WALLET = "0x5202d9b5a43448f939091eb25e6a7816aef3917d" as const;
const OTHER = "0x63fc81ed1e1eab3e2906b578ccd3097970852a1b";
const EXCHANGE = CONTRACTS.exchange;
const USDG = CONTRACTS.usdg;
const CREDIT_ATOMS = 50_000_000n;
const USDG_ATOMS = 37_500_000n;

const bookSnapshot: MarketSnapshot = {
  timestamp: "2026-09-29T12:00:00.000Z",
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

let book = {
  rows: [
    { discountBps: 2500, microUsd: "80000000" },
    { discountBps: 1000, microUsd: "100000000" },
  ],
  totalMicroUsd: "180000000",
  minBuyMicroUsd: "5000000",
};

let targets: TargetRow[] = [];
let decisions: DecisionRow[] = [];
let quoteUsdgBps = 75n;
/** Quoted creditOut in atoms; null fills the requested amount exactly. */
let quoteCreditOutAtoms: bigint | null = null;
/** Requested sizes (atoms) whose quote call fails; "all" fails every quote. */
let failingQuotes: Set<bigint> | "all" = new Set();
/** Target ids whose evaluation write fails at the database. */
let failingTargetWrites = new Set<string>();
let observationRows: { slot_start: string }[] = [];
let alertRows: Record<string, unknown>[] = [];
let head = 1;
const chain = new Map<string, { tx: unknown | null; receipt: unknown | null }>();
const settings = {
  wallet_address: WALLET,
  requested_credit: 5,
  spending_limit_usdg: 25,
  min_discount_percent: 20,
  updated_at: "2026-09-29T12:00:00.000Z",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Mirrors the procurement_targets ready_since trigger. */
function applyReadySinceTrigger(row: TargetRow, previousStatus: string | null) {
  if (row.status === "READY") {
    row.ready_since =
      previousStatus === "READY"
        ? (row.ready_since ?? new Date().toISOString())
        : new Date().toISOString();
  } else {
    row.ready_since = null;
  }
}

function matches(row: Record<string, unknown>, column: string, expr: string) {
  const value = row[column];
  const dot = expr.indexOf(".");
  const op = expr.slice(0, dot);
  const arg = expr.slice(dot + 1);
  if (op === "eq") return value != null && String(value) === arg;
  if (op === "neq") return value != null && String(value) !== arg;
  if (op === "in") {
    const list = arg.replace(/^\(|\)$/g, "").split(",");
    return list.includes(String(value));
  }
  if (op === "is" && arg === "null") return value == null;
  if (op === "ilike") {
    if (value == null) return false;
    const re = new RegExp(
      `^${arg.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/[%*]/g, ".*")}$`,
      "i",
    );
    return re.test(String(value));
  }
  throw new Error(`fake postgrest: unsupported filter ${column}=${expr}`);
}

function filterTable<T extends Record<string, unknown>>(rows: T[], url: URL): T[] {
  return rows.filter((row) => {
    for (const [key, expr] of url.searchParams) {
      if (key === "select" || key === "order" || key === "limit") continue;
      if (key === "or") {
        const parts = expr.replace(/^\(|\)$/g, "").split(",");
        if (!parts.some((p) => matches(row, p.slice(0, p.indexOf(".")), p.slice(p.indexOf(".") + 1)))) {
          return false;
        }
        continue;
      }
      if (!matches(row, key, expr)) return false;
    }
    return true;
  });
}

function rpcResult(data: Hex): Hex {
  const call = decodeFunctionData({ abi: exchangeAbi, data });
  if (call.functionName === "MAX_FILLS") {
    return encodeFunctionResult({ abi: exchangeAbi, functionName: "MAX_FILLS", result: 32n });
  }
  if (call.functionName === "getQuoteForCredit") {
    const [creditAtoms] = call.args as [bigint, bigint];
    if (failingQuotes === "all" || failingQuotes.has(creditAtoms)) {
      throw new Error("rpc down");
    }
    const creditOut = quoteCreditOutAtoms ?? creditAtoms;
    return encodeFunctionResult({
      abi: exchangeAbi,
      functionName: "getQuoteForCredit",
      result: {
        creditOut,
        usdgSpent: (creditOut * quoteUsdgBps) / 100n,
        feeAtoms: 0n,
        fills: 1n,
        reason: 0,
      },
    });
  }
  throw new Error(`fake rpc: unexpected ${call.functionName}`);
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const method = (init?.method ?? "GET").toUpperCase();
  if (url.host === "orbio.test" && url.pathname === "/api/market/book") {
    return json(book);
  }
  if (url.host === "rpc.test") {
    const parsed = JSON.parse(String(init?.body));
    const handle = (req: { id: number; method: string; params: unknown[] }) => {
      const rpc = (result: unknown, error?: unknown) =>
        error
          ? { jsonrpc: "2.0", id: req.id, error }
          : { jsonrpc: "2.0", id: req.id, result };
      if (req.method === "eth_chainId") return rpc("0x1237");
      if (req.method === "eth_blockNumber") return rpc(`0x${head.toString(16)}`);
      if (req.method === "eth_call") {
        try {
          return rpc(rpcResult((req.params[0] as { data: Hex }).data));
        } catch (error) {
          return rpc(null, {
            code: -32000,
            message: error instanceof Error ? error.message : "eth_call failed",
          });
        }
      }
      const entry = chain.get(String(req.params[0]).toLowerCase());
      if (req.method === "eth_getTransactionByHash") return rpc(entry?.tx ?? null);
      if (req.method === "eth_getTransactionReceipt") {
        return rpc(entry?.receipt ?? null);
      }
      return rpc(null, { code: -32601, message: `unexpected ${req.method}` });
    };
    if (Array.isArray(parsed)) {
      return json(parsed.map((req) => handle(req)));
    }
    return json(handle(parsed));
  }
  if (url.host === "supabase.test" && url.pathname === "/rest/v1/settings") {
    return json([settings]);
  }
  if (url.host === "supabase.test" && url.pathname === "/rest/v1/decisions") {
    const accept = new Headers(init?.headers).get("accept") ?? "";
    const asObject = accept.includes("vnd.pgrst.object+json");
    if (method === "GET") {
      const found = filterTable(decisions as unknown as Record<string, unknown>[], url);
      if (asObject) {
        if (found.length === 0) {
          return json(
            { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" },
            406,
          );
        }
        return json(found[0]);
      }
      return json(found);
    }
    if (method === "POST") {
      const body = JSON.parse(String(init?.body)) as DecisionRow;
      decisions.push(body);
      return asObject ? json(body, 201) : json([body], 201);
    }
    if (method === "PATCH") {
      const found = filterTable(decisions as unknown as Record<string, unknown>[], url) as unknown as DecisionRow[];
      const patch = JSON.parse(String(init?.body)) as Partial<DecisionRow>;
      for (const row of found) Object.assign(row, patch);
      if (asObject) {
        if (found.length === 0) {
          return json(
            { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" },
            406,
          );
        }
        return json(found[0]);
      }
      return json(found);
    }
  }
  if (url.host === "supabase.test" && url.pathname === "/rest/v1/procurement_targets") {
    const accept = new Headers(init?.headers).get("accept") ?? "";
    const asObject = accept.includes("vnd.pgrst.object+json");
    if (method === "GET") {
      const found = filterTable(targets as unknown as Record<string, unknown>[], url);
      const limit = url.searchParams.get("limit");
      const sliced = limit ? found.slice(0, Number(limit)) : found;
      if (asObject) {
        if (sliced.length === 0) {
          return json(
            { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" },
            406,
          );
        }
        return json(sliced[0]);
      }
      return json(sliced);
    }
    if (method === "POST") {
      const body = JSON.parse(String(init?.body)) as TargetRow;
      const open = targets.some(
        (row) =>
          row.wallet_address === body.wallet_address &&
          (row.status === "WATCHING" || row.status === "READY"),
      );
      if (open) {
        return json({ code: "23505", message: "duplicate key value violates unique constraint" }, 409);
      }
      const row: TargetRow = {
        ...body,
        cancelled_at: body.cancelled_at ?? null,
        fulfilled_at: body.fulfilled_at ?? null,
        active_decision_id: body.active_decision_id ?? null,
        fulfilled_decision_id: body.fulfilled_decision_id ?? null,
        last_evaluated_at: body.last_evaluated_at ?? null,
        last_evaluation_action: body.last_evaluation_action ?? null,
        last_evaluation_reason: body.last_evaluation_reason ?? null,
        last_requested_amount: body.last_requested_amount ?? null,
        last_executable_discount_percent: body.last_executable_discount_percent ?? null,
        last_executable_total_usdg: body.last_executable_total_usdg ?? null,
        ready_since: null,
      };
      applyReadySinceTrigger(row, null);
      targets.push(row);
      return asObject ? json(row, 201) : json([row], 201);
    }
    if (method === "PATCH") {
      const found = filterTable(targets as unknown as Record<string, unknown>[], url) as unknown as TargetRow[];
      if (found.some((row) => failingTargetWrites.has(row.id))) {
        return json({ code: "XX000", message: "target write failed", details: null, hint: null }, 500);
      }
      const patch = JSON.parse(String(init?.body)) as Partial<TargetRow>;
      for (const row of found) {
        const previousStatus = row.status;
        Object.assign(row, patch);
        applyReadySinceTrigger(row, previousStatus);
      }
      if (asObject) {
        if (found.length === 0) {
          return json(
            { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" },
            406,
          );
        }
        return json(found[0]);
      }
      return json(found);
    }
  }
  if (url.host === "supabase.test" && url.pathname === "/rest/v1/target_alerts") {
    if (method === "GET") return json(filterTable(alertRows, url));
    if (method === "POST") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const conflict = alertRows.some(
        (row) =>
          row.target_id === body.target_id &&
          row.ready_since === body.ready_since &&
          row.channel === body.channel,
      );
      if (conflict) return json([], 201);
      const row = { sent_at: null, created_at: new Date().toISOString(), ...body };
      alertRows.push(row);
      return json([row], 201);
    }
  }
  if (url.host === "supabase.test" && url.pathname === "/rest/v1/market_observations") {
    if (method === "POST") {
      const body = JSON.parse(String(init?.body)) as { slot_start: string };
      if (observationRows.some((row) => row.slot_start === body.slot_start)) return json([], 201);
      observationRows.push({ slot_start: body.slot_start });
      return json([{ slot_start: body.slot_start }], 201);
    }
    if (method === "PATCH") {
      const slot = url.searchParams.get("slot_start")?.slice(3);
      const row = observationRows.find((r) => r.slot_start === slot);
      if (row) Object.assign(row, JSON.parse(String(init?.body)));
      return json(row ? [{ slot_start: row.slot_start }] : []);
    }
  }
  throw new Error(`fake fetch: unexpected ${method} ${url.href}`);
}) as typeof fetch;

const createRoute = await import("../../app/api/targets/route");
const evaluateRoute = await import("../../app/api/targets/evaluate/route");
const cancelRoute = await import("../../app/api/targets/cancel/route");
const reviewRoute = await import("../../app/api/targets/review/route");
const quoteRoute = await import("../../app/api/quote/route");
const validateRoute = await import("../../app/api/execute/validate/route");
const abortRoute = await import("../../app/api/execute/abort/route");
const receiptRoute = await import("../../app/api/execute/receipt/route");
const { evaluateAndPersistTarget, evaluateOpenTargetsAfterObservation } =
  await import("./watch-targets");
const observeRoute = await import("../../app/api/observe/route");

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

async function getTargets(wallet?: string) {
  const path = wallet ? `/api/targets?wallet=${wallet}` : "/api/targets";
  const res = await createRoute.GET(new Request(`http://localhost${path}`));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function toHex(n: number): Hex {
  return `0x${n.toString(16)}`;
}

function hashOf(n: number): Hex {
  return `0x${n.toString(16).padStart(64, "0")}`;
}

const boughtEvent = parseAbiItem(
  "event Bought(address indexed buyer, address indexed recipient, uint256 creditOut, uint256 usdgSpent, uint256 feeAtoms, uint256 fills)",
);
const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

function buyInput(usdgIn: bigint = USDG_ATOMS): Hex {
  return encodeFunctionData({
    abi: exchangeAbi,
    functionName: "buyAndActivate",
    args: [usdgIn, 49_000_000n, beneficiaryBytes32(WALLET), 32n],
  });
}

function rawTx(hash: Hex, input: Hex, block: number | null, to: string = EXCHANGE) {
  return {
    blockHash: block == null ? null : `0x${"11".repeat(32)}`,
    blockNumber: block == null ? null : toHex(block),
    from: WALLET,
    hash,
    input,
    to,
    transactionIndex: block == null ? null : "0x1",
    value: "0x0",
    type: "0x2",
  };
}

function rawReceipt(
  hash: Hex,
  block: number,
  overrides: { status?: string; logs?: unknown[] } = {},
) {
  const logs = overrides.logs ?? [
    {
      address: EXCHANGE,
      topics: encodeEventTopics({
        abi: [boughtEvent],
        eventName: "Bought",
        args: { buyer: WALLET, recipient: EXCHANGE },
      }),
      data: encodeAbiParameters(
        [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
        [CREDIT_ATOMS, USDG_ATOMS, 0n, 1n],
      ),
    },
    {
      address: USDG,
      topics: encodeEventTopics({
        abi: [transferEvent],
        eventName: "Transfer",
        args: { from: WALLET, to: EXCHANGE },
      }),
      data: encodeAbiParameters([{ type: "uint256" }], [USDG_ATOMS]),
    },
  ];
  return {
    blockHash: `0x${"11".repeat(32)}`,
    blockNumber: toHex(block),
    from: WALLET,
    logs: (logs as Array<Record<string, unknown>>).map((log, i) => ({
      ...log,
      logIndex: toHex(i),
      removed: false,
      blockNumber: toHex(block),
      blockHash: `0x${"11".repeat(32)}`,
      transactionHash: hash,
      transactionIndex: "0x1",
    })),
    status: overrides.status ?? "0x1",
    to: EXCHANGE,
    transactionHash: hash,
    transactionIndex: "0x1",
    type: "0x2",
  };
}

function reset() {
  targets = [];
  decisions = [];
  quoteUsdgBps = 75n;
  quoteCreditOutAtoms = null;
  failingQuotes = new Set();
  failingTargetWrites = new Set();
  observationRows = [];
  alertRows = [];
  head = 1;
  chain.clear();
  settings.spending_limit_usdg = 25;
  settings.min_discount_percent = 20;
  settings.requested_credit = 5;
  book = {
    rows: [
      { discountBps: 2500, microUsd: "80000000" },
      { discountBps: 1000, microUsd: "100000000" },
    ],
    totalMicroUsd: "180000000",
    minBuyMicroUsd: "5000000",
  };
}

const targetBody = {
  walletAddress: WALLET,
  requestedCredit: 50,
  minDiscountPercent: 20,
  maxSpendUsdg: 40,
};

reset();
{
  const missing = await post(createRoute, "/api/targets", { requestedCredit: 50, minDiscountPercent: 20, maxSpendUsdg: 40 });
  assert(missing.status === 400, "create requires a wallet");
  const bad = await post(createRoute, "/api/targets", { ...targetBody, requestedCredit: 0 });
  assert(bad.status === 400, "create rejects zero CREDIT");
  const created = await post(createRoute, "/api/targets", targetBody);
  assert(created.status === 201, `create succeeds (got ${created.status}: ${JSON.stringify(created.body)})`);
  const target = created.body.target as { id: string; status: string; requestedCredit: number };
  assert(target.status === "WATCHING" && target.requestedCredit === 50, "new target is WATCHING");
  assert(settings.requested_credit === 5 && settings.spending_limit_usdg === 25, "create does not rewrite settings");
  const again = await post(createRoute, "/api/targets", targetBody);
  assert(again.status === 409 && again.body.code === "open_target_exists", "one open target per wallet");
  const foreign = await post(evaluateRoute, "/api/targets/evaluate", {
    targetId: target.id,
    walletAddress: OTHER,
  });
  assert(foreign.status === 403, "foreign wallet cannot evaluate");
  const beforeDecisions = decisions.length;
  const evaluated = await post(evaluateRoute, "/api/targets/evaluate", {
    targetId: target.id,
    walletAddress: WALLET,
  });
  assert(evaluated.status === 200, `evaluate succeeds (got ${evaluated.status}: ${JSON.stringify(evaluated.body)})`);
  const ready = evaluated.body.target as { status: string; lastExecutableTotalUsdg: number };
  assert(ready.status === "READY", "qualifying book plus quote is READY");
  assert(ready.lastExecutableTotalUsdg === 37.5, "READY stores executable USDG, not book price");
  assert(decisions.length === beforeDecisions, "evaluate does not create a decision");
  const repeat = await post(evaluateRoute, "/api/targets/evaluate", {
    targetId: target.id,
    walletAddress: WALLET,
  });
  assert((repeat.body.target as { status: string }).status === "READY", "repeat evaluate stays READY");
}

reset();
{
  book = {
    rows: [
      { discountBps: 2500, microUsd: "30000000" },
      { discountBps: 1000, microUsd: "100000000" },
    ],
    totalMicroUsd: "130000000",
    minBuyMicroUsd: "5000000",
  };
  const created = await post(createRoute, "/api/targets", targetBody);
  const target = created.body.target as { id: string };
  const evaluated = await post(evaluateRoute, "/api/targets/evaluate", {
    targetId: target.id,
    walletAddress: WALLET,
  });
  assert((evaluated.body.target as { status: string }).status === "WATCHING", "50 vs 30 stays WATCHING");
  assert(decisions.length === 0, "WATCHING evaluate creates no decision");
}

reset();
{
  const created = await post(createRoute, "/api/targets", {
    ...targetBody,
    minDiscountPercent: 30,
  });
  const target = created.body.target as { id: string };
  const evaluated = await post(evaluateRoute, "/api/targets/evaluate", {
    targetId: target.id,
    walletAddress: WALLET,
  });
  assert((evaluated.body.target as { status: string }).status === "WATCHING", "book 25% below 30% min stays WATCHING");
}

reset();
{
  const created = await post(createRoute, "/api/targets", {
    ...targetBody,
    maxSpendUsdg: 30,
  });
  const target = created.body.target as { id: string };
  const evaluated = await post(evaluateRoute, "/api/targets/evaluate", {
    targetId: target.id,
    walletAddress: WALLET,
  });
  assert(
    (evaluated.body.target as { status: string }).status === "WATCHING",
    `37.5 USDG above 30 max spend stays WATCHING (got ${JSON.stringify(evaluated.body)})`,
  );
}

reset();
{
  const created = await post(createRoute, "/api/targets", targetBody);
  const target = created.body.target as { id: string };
  await post(evaluateRoute, "/api/targets/evaluate", {
    targetId: target.id,
    walletAddress: WALLET,
  });
  book = {
    rows: [{ discountBps: 2500, microUsd: "30000000" }],
    totalMicroUsd: "30000000",
    minBuyMicroUsd: "5000000",
  };
  const moved = await post(evaluateRoute, "/api/targets/evaluate", {
    targetId: target.id,
    walletAddress: WALLET,
  });
  assert((moved.body.target as { status: string }).status === "WATCHING", "READY returns to WATCHING when size disappears");
}

reset();
{
  const created = await post(createRoute, "/api/targets", targetBody);
  const target = created.body.target as { id: string };
  const reviewed = await post(reviewRoute, "/api/targets/review", {
    targetId: target.id,
    walletAddress: WALLET,
  });
  assert(reviewed.status === 200, `review succeeds (got ${reviewed.status}: ${JSON.stringify(reviewed.body)})`);
  const record = reviewed.body.record as {
    id: string;
    decision: string;
    requested_amount?: number;
    requestedAmount?: number;
    targetId?: string;
    minDiscountPercent?: number;
    evaluatedSpendingLimitUsdg?: number;
  };
  assert(record.decision === "BUY", "review creates a BUY decision");
  assert(record.targetId === target.id, "decision references the target");
  assert(record.requestedAmount === 50, "frozen amount is 50 CREDIT");
  assert(record.minDiscountPercent === 20, "frozen min discount is the target's");
  assert(record.evaluatedSpendingLimitUsdg === 40, "frozen spend is the target's 40, not settings 25");
  settings.spending_limit_usdg = 10;
  settings.min_discount_percent = 90;
  settings.requested_credit = 5;
  const quoted = await post(quoteRoute, "/api/quote", {
    decisionId: record.id,
    walletAddress: WALLET,
  });
  assert(quoted.status === 200, `target quote uses frozen params (got ${quoted.status}: ${JSON.stringify(quoted.body)})`);
  const quote = quoted.body.quote as ExecutableQuote;
  assert(quote.requestedCredit === 50, "quote amount is the frozen 50 CREDIT");
  assert(quote.totalUsdg === 37.5, "quote is executable USDG");
  assert(quoted.body.spendingLimitUsdg === 40, "quote checks the target max spend, not settings");
  settings.spending_limit_usdg = 25;
  settings.min_discount_percent = 20;
}

reset();
{
  const created = await post(createRoute, "/api/targets", targetBody);
  const target = created.body.target as { id: string };
  book = {
    rows: [{ discountBps: 1000, microUsd: "80000000" }],
    totalMicroUsd: "80000000",
    minBuyMicroUsd: "5000000",
  };
  const reviewed = await post(reviewRoute, "/api/targets/review", {
    targetId: target.id,
    walletAddress: WALLET,
  });
  assert(reviewed.status === 409 && reviewed.body.code === "not_ready", "review re-evaluates and refuses a non-qualifying market");
  assert((reviewed.body.target as { status: string }).status === "WATCHING", "failed review returns to WATCHING");
  assert(decisions.length === 0, "failed review creates no BUY decision");
}

reset();
{
  const created = await post(createRoute, "/api/targets", targetBody);
  const target = created.body.target as { id: string };
  const cancelled = await post(cancelRoute, "/api/targets/cancel", {
    targetId: target.id,
    walletAddress: WALLET,
  });
  assert(cancelled.status === 200, "cancel succeeds");
  assert((cancelled.body.target as { status: string }).status === "CANCELLED", "cancelled is retained");
  const ready = await post(evaluateRoute, "/api/targets/evaluate", {
    targetId: target.id,
    walletAddress: WALLET,
  });
  assert((ready.body.target as { status: string }).status === "CANCELLED", "cancelled cannot become READY");
  const again = await post(cancelRoute, "/api/targets/cancel", {
    targetId: target.id,
    walletAddress: WALLET,
  });
  assert(again.status === 409, "cancelled target cannot be cancelled into another state");
  const review = await post(reviewRoute, "/api/targets/review", {
    targetId: target.id,
    walletAddress: WALLET,
  });
  assert(review.status === 409, "cancelled target cannot be purchased");
}

reset();
{
  const empty = await getTargets();
  assert(empty.status === 200 && empty.body.target == null, "GET without wallet returns no target");
  const created = await post(createRoute, "/api/targets", targetBody);
  const target = created.body.target as { id: string; status: string };
  const listed = await getTargets(WALLET);
  assert(
    (listed.body.target as { id: string }).id === target.id,
    "GET returns the open target",
  );
  const foreign = await getTargets(OTHER);
  assert(foreign.body.target == null, "GET does not leak another wallet's target");
}

reset();
{
  const created = await post(createRoute, "/api/targets", targetBody);
  const target = created.body.target as { id: string };
  await evaluateOpenTargetsAfterObservation({
    levels: [
      { discountBps: 2500, creditAtoms: 80_000_000 },
      { discountBps: 1000, creditAtoms: 100_000_000 },
    ],
    minBuyCreditAtoms: 5_000_000,
    reportedTotalCreditAtoms: 180_000_000,
    fingerprint: "obs-qualifying",
  });
  assert(targets[0].status === "READY", "observation watcher READYs a qualifying book");
  assert(decisions.length === 0, "observation watcher creates no BUY decision");
  await evaluateOpenTargetsAfterObservation({
    levels: [{ discountBps: 2500, creditAtoms: 30_000_000 }],
    minBuyCreditAtoms: 5_000_000,
    reportedTotalCreditAtoms: 30_000_000,
    fingerprint: "obs-thin",
  });
  const afterThin = targets[0].status as string;
  assert(afterThin === "WATCHING", "observation watcher returns READY to WATCHING");
  void target;
}

reset();
{
  const created = await post(createRoute, "/api/targets", targetBody);
  const target = created.body.target as { id: string };
  const reviewed = await post(reviewRoute, "/api/targets/review", {
    targetId: target.id,
    walletAddress: WALLET,
  });
  const record = reviewed.body.record as { id: string };
  const quoted = await post(quoteRoute, "/api/quote", {
    decisionId: record.id,
    walletAddress: WALLET,
  });
  const quote = quoted.body.quote as ExecutableQuote;
  quoteUsdgBps = 80n;
  const validated = await post(validateRoute, "/api/execute/validate", {
    decisionId: record.id,
    quote,
    walletAddress: WALLET,
  });
  assert(validated.status === 409 && validated.body.code === "stale", "quote change before signing is rejected");
  assert((targets[0].status as string) !== "FULFILLED", "stale quote does not fulfill the target");
  assert(decisions[0].execution_status === "stale_quote", "decision is marked stale_quote, not success");
}

reset();
{
  const created = await post(createRoute, "/api/targets", targetBody);
  const target = created.body.target as { id: string };
  const reviewed = await post(reviewRoute, "/api/targets/review", {
    targetId: target.id,
    walletAddress: WALLET,
  });
  const record = reviewed.body.record as { id: string };
  const aborted = await post(abortRoute, "/api/execute/abort", {
    decisionId: record.id,
    walletAddress: WALLET,
  });
  assert(aborted.status === 200, "abort records the failed purchase");
  assert((targets[0].status as string) === "WATCHING", "failed purchase returns the target to WATCHING");
  assert(targets[0].fulfilled_decision_id == null, "failed purchase does not fulfill");
}

reset();
{
  const created = await post(createRoute, "/api/targets", targetBody);
  const target = created.body.target as { id: string };
  await post(evaluateRoute, "/api/targets/evaluate", {
    targetId: target.id,
    walletAddress: WALLET,
  });
  const failed = await fulfillTargetFromDecision({
    id: "dec-fail",
    timestamp: bookSnapshot.timestamp,
    market: { price: 0.75, discountPercent: 25, availableDepth: 80 },
    snapshot: bookSnapshot,
    decision: "BUY",
    reason: "fixture",
    requestedAmount: 50,
    walletAddress: WALLET,
    targetId: target.id,
    executionStatus: "failed",
  });
  assert(failed == null, "failed execution cannot fulfill");
  assert(targets[0].status === "READY", "unverified failure leaves the target unfulfilled");
  const pending = await fulfillTargetFromDecision({
    id: "dec-pending",
    timestamp: bookSnapshot.timestamp,
    market: { price: 0.75, discountPercent: 25, availableDepth: 80 },
    snapshot: bookSnapshot,
    decision: "BUY",
    reason: "fixture",
    requestedAmount: 50,
    walletAddress: WALLET,
    targetId: target.id,
    executionStatus: "pending",
  });
  assert(pending == null, "pending receipt cannot fulfill");
  assert(targets[0].status === "READY", "only success can fulfill");
}

reset();
{
  const created = await post(createRoute, "/api/targets", targetBody);
  const target = created.body.target as { id: string };
  const reviewed = await post(reviewRoute, "/api/targets/review", {
    targetId: target.id,
    walletAddress: WALLET,
  });
  const record = reviewed.body.record as { id: string };
  const quoted = await post(quoteRoute, "/api/quote", {
    decisionId: record.id,
    walletAddress: WALLET,
  });
  const quote = quoted.body.quote as ExecutableQuote;
  const validated = await post(validateRoute, "/api/execute/validate", {
    decisionId: record.id,
    quote,
    walletAddress: WALLET,
  });
  assert(validated.status === 200, `validate succeeds (got ${validated.status}: ${JSON.stringify(validated.body)})`);

  const unseen = hashOf(0xd1);
  const pending = await post(receiptRoute, "/api/execute/receipt", {
    decisionId: record.id,
    txHash: unseen,
    walletAddress: WALLET,
    creditAcquired: 999,
    totalUsdgPaid: 0.01,
  });
  assert(pending.status === 202, "unseen tx does not settle");
  assert((targets[0].status as string) !== "FULFILLED", "unseen tx does not fulfill");

  const badDest = hashOf(0xb1);
  chain.set(badDest, {
    tx: rawTx(badDest, buyInput(), 2, USDG),
    receipt: rawReceipt(badDest, 2),
  });
  const failed = await post(receiptRoute, "/api/execute/receipt", {
    decisionId: record.id,
    txHash: badDest,
    walletAddress: WALLET,
    creditAcquired: 999,
    totalUsdgPaid: 0.01,
  });
  assert(failed.status === 409, "wrong destination is not a purchase");
  assert((targets[0].status as string) === "WATCHING", "failed transaction returns the target to WATCHING");
  assert(targets[0].fulfilled_at == null, "failed transaction does not fulfill");
}

reset();
{
  const created = await post(createRoute, "/api/targets", targetBody);
  const target = created.body.target as { id: string };
  const reviewed = await post(reviewRoute, "/api/targets/review", {
    targetId: target.id,
    walletAddress: WALLET,
  });
  const record = reviewed.body.record as { id: string };
  const quoted = await post(quoteRoute, "/api/quote", {
    decisionId: record.id,
    walletAddress: WALLET,
  });
  const quote = quoted.body.quote as ExecutableQuote;
  await post(validateRoute, "/api/execute/validate", {
    decisionId: record.id,
    quote,
    walletAddress: WALLET,
  });
  const reverted = hashOf(0xc1);
  chain.set(reverted, {
    tx: rawTx(reverted, buyInput(), 2),
    receipt: rawReceipt(reverted, 2, { status: "0x0", logs: [] }),
  });
  const result = await post(receiptRoute, "/api/execute/receipt", {
    decisionId: record.id,
    txHash: reverted,
    walletAddress: WALLET,
  });
  assert(result.status === 409, "reverted purchase is rejected");
  assert((targets[0].status as string) === "WATCHING", "reverted transaction returns the target to WATCHING");
  assert(targets[0].fulfilled_decision_id == null, "reverted purchase does not fulfill");
}

reset();
{
  const created = await post(createRoute, "/api/targets", targetBody);
  const target = created.body.target as { id: string };
  const reviewed = await post(reviewRoute, "/api/targets/review", {
    targetId: target.id,
    walletAddress: WALLET,
  });
  const record = reviewed.body.record as { id: string };
  const quoted = await post(quoteRoute, "/api/quote", {
    decisionId: record.id,
    walletAddress: WALLET,
  });
  const quote = quoted.body.quote as ExecutableQuote;
  await post(validateRoute, "/api/execute/validate", {
    decisionId: record.id,
    quote,
    walletAddress: WALLET,
  });
  const ok = hashOf(0x51);
  chain.set(ok, {
    tx: rawTx(ok, buyInput(), 2),
    receipt: rawReceipt(ok, 2),
  });
  const settled = await post(receiptRoute, "/api/execute/receipt", {
    decisionId: record.id,
    txHash: ok,
    walletAddress: WALLET,
    creditAcquired: 999,
    totalUsdgPaid: 0.01,
  });
  assert(settled.status === 200, `verified receipt succeeds (got ${settled.status}: ${JSON.stringify(settled.body)})`);
  assert(targets[0].status === "FULFILLED", "only a verified receipt fulfills the target");
  assert(targets[0].fulfilled_decision_id === record.id, "fulfilled decision is stored");
  assert(targets[0].fulfilled_at != null, "fulfilled_at is stored");
  assert(decisions[0].credit_acquired === 50, "CREDIT acquired comes from the receipt");
  assert(decisions[0].total_usdg_paid === 37.5, "USDG paid comes from the receipt, not the client");
  const again = await post(evaluateRoute, "/api/targets/evaluate", {
    targetId: target.id,
    walletAddress: WALLET,
  });
  assert((again.body.target as { status: string }).status === "FULFILLED", "fulfilled cannot return to READY");
}

// ---------------------------------------------------------------------------
// Continuous watching: inconclusive evaluations, isolation, in-flight
// purchases, stale writes, and the full target amount.
// ---------------------------------------------------------------------------

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
const READY_FIELDS = {
  status: "READY",
  last_evaluated_at: "2026-10-04T12:00:00.000Z",
  last_evaluation_action: "BUY",
  last_evaluation_reason: "ready fixture",
  last_requested_amount: 50,
  last_executable_discount_percent: 25,
  last_executable_total_usdg: 37.5,
} as const;

function walletN(n: number): string {
  return `0x${n.toString(16).padStart(40, "0")}`;
}

function seedTarget(id: string, overrides: Partial<TargetRow> = {}): TargetRow {
  const row: TargetRow = {
    id,
    wallet_address: WALLET,
    requested_credit: 50,
    min_discount_percent: 20,
    max_spend_usdg: 40,
    status: "WATCHING",
    created_at: "2026-10-04T12:00:00.000Z",
    updated_at: "2026-10-04T12:00:00.000Z",
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
  if (row.status === "READY" && row.ready_since == null) {
    row.ready_since = row.last_evaluated_at;
  }
  targets.push(row);
  return row;
}

function seedDecision(
  id: string,
  wallet: string,
  targetId: string,
  status: ExecutionStatus,
): DecisionRow {
  const row: DecisionRow = {
    id,
    wallet_address: wallet,
    timestamp: bookSnapshot.timestamp,
    market: { price: 0.75, discountPercent: 25, availableDepth: 80 },
    snapshot: bookSnapshot,
    decision: "BUY",
    reason: "fixture",
    requested_amount: 50,
    quote_price: 0.75,
    quoted_usdg: 37.5,
    quoted_at: bookSnapshot.timestamp,
    validated_block: 1,
    min_discount_percent: 20,
    evaluated_requested_credit: null,
    target_id: targetId,
    execution_price: null,
    tx_hash: status === "pending" ? hashOf(0xee) : null,
    execution_status: status,
    blocked_reason: null,
    credit_acquired: null,
    total_usdg_paid: null,
    confirmed_at: null,
    reasoning: null,
  };
  decisions.push(row);
  return row;
}

function observe() {
  return observeRoute.GET(
    new Request("http://localhost/api/observe", {
      headers: { authorization: "Bearer test-cron-secret" },
    }),
  );
}

// Quote failure on a qualifying book: READY stays READY with its quote fields.
reset();
{
  seedTarget("tgt-ready-inconclusive", { ...READY_FIELDS });
  const before = JSON.stringify(targets[0]);
  failingQuotes = "all";
  const results = await evaluateOpenTargetsAfterObservation(qualifyingBook);
  assert(
    results.length === 1 && results[0].result === "inconclusive",
    `quote failure is inconclusive (got ${JSON.stringify(results)})`,
  );
  assert(JSON.stringify(targets[0]) === before, "READY target is unchanged by an inconclusive quote");
  assert(decisions.length === 0, "inconclusive evaluation creates no decision");
}

// Quote failure on a qualifying book: WATCHING stays WATCHING.
reset();
{
  seedTarget("tgt-watch-inconclusive");
  const before = JSON.stringify(targets[0]);
  failingQuotes = "all";
  const results = await evaluateOpenTargetsAfterObservation(qualifyingBook);
  assert(results[0].result === "inconclusive", "WATCHING quote failure is inconclusive");
  assert(JSON.stringify(targets[0]) === before, "WATCHING target is unchanged by an inconclusive quote");
}

// Quote failure on page-load evaluate and review keeps the stored state.
reset();
{
  seedTarget("tgt-live-inconclusive", { ...READY_FIELDS });
  const before = JSON.stringify(targets[0]);
  failingQuotes = "all";
  const evaluated = await post(evaluateRoute, "/api/targets/evaluate", {
    targetId: "tgt-live-inconclusive",
    walletAddress: WALLET,
  });
  assert(evaluated.status === 200, "inconclusive live evaluate still answers");
  assert((evaluated.body.target as { status: string }).status === "READY", "live evaluate keeps READY on quote failure");
  assert(JSON.stringify(targets[0]) === before, "live evaluate writes nothing when inconclusive");
  const reviewed = await post(reviewRoute, "/api/targets/review", {
    targetId: "tgt-live-inconclusive",
    walletAddress: WALLET,
  });
  assert(reviewed.status === 503 && reviewed.body.code === "inconclusive", "review refuses an inconclusive quote");
  assert(!String(reviewed.body.error).includes("rpc down"), "review does not expose the infrastructure error");
  assert(JSON.stringify(targets[0]) === before && decisions.length === 0, "inconclusive review changes nothing");
}

// A non-qualifying book is conclusive even when quotes are broken.
reset();
{
  seedTarget("tgt-ready-thin", { ...READY_FIELDS });
  failingQuotes = "all";
  const results = await evaluateOpenTargetsAfterObservation(thinBook);
  assert(results[0].result === "written", "non-qualifying book writes");
  assert(targets[0].status === "WATCHING", "non-qualifying market returns READY to WATCHING");
  assert(targets[0].last_executable_total_usdg == null, "WATCHING clears the READY quote");
}

// One pass, isolated targets: READY, INCONCLUSIVE, WATCHING, error, READY.
reset();
{
  seedTarget("tgt-a", { wallet_address: walletN(0xa) });
  seedTarget("tgt-b", { wallet_address: walletN(0xb), requested_credit: 60, max_spend_usdg: 60 });
  seedTarget("tgt-c", { wallet_address: walletN(0xc), ...READY_FIELDS, min_discount_percent: 30 });
  seedTarget("tgt-d", { wallet_address: walletN(0xd) });
  seedTarget("tgt-e", { wallet_address: walletN(0xe), requested_credit: 70, max_spend_usdg: 60 });
  failingQuotes = new Set([60_000_000n]);
  failingTargetWrites = new Set(["tgt-d"]);
  const bBefore = JSON.stringify(targets[1]);
  const dBefore = JSON.stringify(targets[3]);
  const results = await evaluateOpenTargetsAfterObservation(qualifyingBook);
  const byId = Object.fromEntries(results.map((r) => [r.targetId, r.result]));
  assert(results.length === 5, "every open target is visited");
  assert(byId["tgt-a"] === "written" && targets[0].status === "READY", "A becomes READY");
  assert(byId["tgt-b"] === "inconclusive" && JSON.stringify(targets[1]) === bBefore, "B is inconclusive and unchanged");
  assert(byId["tgt-c"] === "written" && targets[2].status === "WATCHING", "C becomes WATCHING");
  assert(byId["tgt-d"] === "error" && JSON.stringify(targets[3]) === dBefore, "D fails alone and is unchanged");
  assert(byId["tgt-e"] === "written" && targets[4].status === "READY", "E becomes READY after D failed");
}

// The observation itself stays successful when one target evaluation fails.
reset();
{
  seedTarget("tgt-ok", { wallet_address: walletN(0x1) });
  seedTarget("tgt-broken", { wallet_address: walletN(0x2) });
  failingTargetWrites = new Set(["tgt-broken"]);
  const response = await observe();
  const result = (await response.json()) as Record<string, unknown>;
  assert(response.status === 200 && result.outcome === "succeeded", "observation succeeds despite a target failure");
  assert(
    observationRows.length === 1 &&
      (observationRows[0] as { outcome?: string }).outcome === "succeeded",
    "observation row is completed as succeeded",
  );
  assert(targets[0].status === "READY", "successful observation evaluates open targets");
  assert(targets[1].status === "WATCHING", "failed target write leaves that target as it was");
  assert(
    alertRows.length === 1 && alertRows[0].target_id === "tgt-ok",
    "scheduled observation records one alert for the target it made READY",
  );
  const duplicate = (await (await observe()).json()) as Record<string, unknown>;
  assert(duplicate.status === "duplicate", "duplicate scheduler call does not re-evaluate");
  assert(alertRows.length === 1, "duplicate scheduler call records no alert");
}

// In-flight purchase: awaiting_signature and pending targets are left alone.
reset();
{
  const created = await post(createRoute, "/api/targets", targetBody);
  const target = created.body.target as { id: string };
  const reviewed = await post(reviewRoute, "/api/targets/review", {
    targetId: target.id,
    walletAddress: WALLET,
  });
  const record = reviewed.body.record as { id: string };
  const quoted = await post(quoteRoute, "/api/quote", {
    decisionId: record.id,
    walletAddress: WALLET,
  });
  const validated = await post(validateRoute, "/api/execute/validate", {
    decisionId: record.id,
    quote: quoted.body.quote,
    walletAddress: WALLET,
  });
  assert(validated.status === 200, `validate succeeds (got ${validated.status}: ${JSON.stringify(validated.body)})`);
  assert(decisions[0].execution_status === "awaiting_signature", "decision awaits signature");
  assert(targets[0].status === "READY" && targets[0].active_decision_id === record.id, "target is READY and linked");
  const before = JSON.stringify(targets[0]);

  let results = await evaluateOpenTargetsAfterObservation(thinBook);
  assert(results[0].result === "in_flight", "watcher skips an awaiting_signature target");
  assert(JSON.stringify(targets[0]) === before, "awaiting_signature target keeps READY and its quote fields");
  book = {
    rows: [{ discountBps: 2500, microUsd: "30000000" }],
    totalMicroUsd: "30000000",
    minBuyMicroUsd: "5000000",
  };
  const live = await post(evaluateRoute, "/api/targets/evaluate", {
    targetId: target.id,
    walletAddress: WALLET,
  });
  assert((live.body.target as { status: string }).status === "READY", "page-load evaluate leaves an in-flight target");
  assert(JSON.stringify(targets[0]) === before, "page-load evaluate writes nothing while in flight");

  const second = await post(reviewRoute, "/api/targets/review", {
    targetId: target.id,
    walletAddress: WALLET,
  });
  assert(second.status === 409 && second.body.code === "purchase_in_flight", "review refuses while awaiting_signature");
  assert(decisions.length === 1, "no second purchase decision while awaiting_signature");

  decisions[0].execution_status = "pending";
  decisions[0].tx_hash = hashOf(0xab);
  results = await evaluateOpenTargetsAfterObservation(thinBook);
  assert(results[0].result === "in_flight", "watcher skips a pending target");
  assert(JSON.stringify(targets[0]) === before, "pending target keeps READY and its quote fields");
  const third = await post(reviewRoute, "/api/targets/review", {
    targetId: target.id,
    walletAddress: WALLET,
  });
  assert(third.status === 409 && third.body.code === "purchase_in_flight", "review refuses while pending");
  assert(decisions.length === 1, "no second purchase decision while pending");
}

// Seeded pending WATCHING target is not promoted by a qualifying book.
reset();
{
  seedTarget("tgt-pending-watch", { active_decision_id: "dec-pending" });
  seedDecision("dec-pending", WALLET, "tgt-pending-watch", "pending");
  const before = JSON.stringify(targets[0]);
  const results = await evaluateOpenTargetsAfterObservation(qualifyingBook);
  assert(results[0].result === "in_flight", "pending WATCHING target is skipped");
  assert(JSON.stringify(targets[0]) === before, "pending WATCHING target is not promoted to READY");
}

// A finished active decision does not block watching.
reset();
{
  seedTarget("tgt-old-decision", { active_decision_id: "dec-old" });
  seedDecision("dec-old", WALLET, "tgt-old-decision", "stale_quote");
  const results = await evaluateOpenTargetsAfterObservation(qualifyingBook);
  assert(results[0].result === "written" && targets[0].status === "READY", "stale_quote active decision does not block READY");
}

// Stale writes: an older evaluation cannot overwrite a newer target state.
reset();
{
  const created = await post(createRoute, "/api/targets", targetBody);
  const snapshot = created.body.target as ProcurementTarget;
  await new Promise((resolve) => setTimeout(resolve, 5));
  const newer = await post(evaluateRoute, "/api/targets/evaluate", {
    targetId: snapshot.id,
    walletAddress: WALLET,
  });
  assert((newer.body.target as { status: string }).status === "READY", "newer evaluation is READY");
  assert(targets[0].updated_at !== snapshot.updatedAt, "newer evaluation advanced updated_at");
  const after = JSON.stringify(targets[0]);

  const stale = await evaluateTarget(marketSnapshotFromObservedBook(thinBook), targetBody);
  assert(stale.outcome === "NOT_QUALIFIED", "older evaluation would be WATCHING");
  const written = await persistTargetEvaluation(snapshot, stale);
  assert(written === null, "stale write is refused");
  assert(JSON.stringify(targets[0]) === after, "older evaluation did not overwrite READY");
  const watched = await evaluateAndPersistTarget(
    snapshot,
    marketSnapshotFromObservedBook(thinBook),
    undefined,
  );
  assert(watched.kind === "superseded", "watcher reports a superseded evaluation");
  assert(JSON.stringify(targets[0]) === after, "superseded watcher pass did not overwrite READY");

  const current = await requireOwnedTarget(snapshot.id, WALLET);
  assert("target" in current, "current target readable");
  const fresh = await persistTargetEvaluation(current.target, stale);
  assert(fresh?.status === "WATCHING", "an evaluation of the current state does write");
}

// Stale writes: a watcher snapshot taken before review cannot undo the review link.
reset();
{
  const created = await post(createRoute, "/api/targets", targetBody);
  const snapshot = created.body.target as ProcurementTarget;
  await new Promise((resolve) => setTimeout(resolve, 5));
  const reviewed = await post(reviewRoute, "/api/targets/review", {
    targetId: snapshot.id,
    walletAddress: WALLET,
  });
  const record = reviewed.body.record as { id: string };
  const after = JSON.stringify(targets[0]);
  const watched = await evaluateAndPersistTarget(
    snapshot,
    marketSnapshotFromObservedBook(thinBook),
    undefined,
  );
  assert(watched.kind === "superseded", "pre-review snapshot is superseded");
  assert(JSON.stringify(targets[0]) === after, "pre-review snapshot did not overwrite the reviewed target");
  assert(targets[0].active_decision_id === record.id, "review link survives the stale write");
}

// Full target amount: 50 CREDIT target with a 47 CREDIT executable quote.
reset();
{
  const created = await post(createRoute, "/api/targets", targetBody);
  const target = created.body.target as { id: string };
  quoteCreditOutAtoms = 47_000_000n;
  const evaluated = await post(evaluateRoute, "/api/targets/evaluate", {
    targetId: target.id,
    walletAddress: WALLET,
  });
  const partial = evaluated.body.target as ProcurementTarget;
  assert(partial.status === "WATCHING", "47 of 50 CREDIT is not READY");
  assert(partial.lastEvaluationAction === "WAIT", "partial fill records WAIT");
  assert(partial.lastExecutableTotalUsdg == null, "partial fill stores no READY quote");
  const results = await evaluateOpenTargetsAfterObservation(qualifyingBook);
  assert(results[0].result === "written" && targets[0].status === "WATCHING", "watcher keeps a partial fill WATCHING");
  const reviewed = await post(reviewRoute, "/api/targets/review", {
    targetId: target.id,
    walletAddress: WALLET,
  });
  assert(reviewed.status === 409 && reviewed.body.code === "not_ready", "review refuses a partial fill");
  assert(decisions.length === 0, "partial fill creates no BUY decision");

  quoteCreditOutAtoms = null;
  const full = await post(evaluateRoute, "/api/targets/evaluate", {
    targetId: target.id,
    walletAddress: WALLET,
  });
  assert((full.body.target as { status: string }).status === "READY", "50 of 50 CREDIT is READY");
}

// Full target amount: quote and validate refuse a partial fill after review.
reset();
{
  const created = await post(createRoute, "/api/targets", targetBody);
  const target = created.body.target as { id: string };
  const reviewed = await post(reviewRoute, "/api/targets/review", {
    targetId: target.id,
    walletAddress: WALLET,
  });
  const record = reviewed.body.record as { id: string };
  quoteCreditOutAtoms = 47_000_000n;
  const partialQuote = await post(quoteRoute, "/api/quote", {
    decisionId: record.id,
    walletAddress: WALLET,
  });
  assert(partialQuote.status === 409 && partialQuote.body.code === "liquidity", "quote refuses a partial target fill");
  quoteCreditOutAtoms = null;
  const quoted = await post(quoteRoute, "/api/quote", {
    decisionId: record.id,
    walletAddress: WALLET,
  });
  assert(quoted.status === 200, "full quote is offered");
  quoteCreditOutAtoms = 47_000_000n;
  const validated = await post(validateRoute, "/api/execute/validate", {
    decisionId: record.id,
    quote: quoted.body.quote,
    walletAddress: WALLET,
  });
  assert(validated.status === 409 && validated.body.code === "liquidity", "validate refuses a partial target fill");
  assert(decisions[0].execution_status === "blocked_liquidity", "partial revalidation is blocked, not signable");
  assert(targets[0].status !== "FULFILLED", "partial quote does not fulfill");
}

// Only the target's active decision can be validated for signing.
reset();
{
  const created = await post(createRoute, "/api/targets", targetBody);
  const target = created.body.target as { id: string };
  const first = await post(reviewRoute, "/api/targets/review", {
    targetId: target.id,
    walletAddress: WALLET,
  });
  const firstRecord = first.body.record as { id: string };
  const firstQuote = await post(quoteRoute, "/api/quote", {
    decisionId: firstRecord.id,
    walletAddress: WALLET,
  });
  const second = await post(reviewRoute, "/api/targets/review", {
    targetId: target.id,
    walletAddress: WALLET,
  });
  assert(second.status === 200, "a new review is allowed before anything is signable");
  const secondRecord = second.body.record as { id: string };
  assert(targets[0].active_decision_id === secondRecord.id, "the newer review is active");
  const old = await post(validateRoute, "/api/execute/validate", {
    decisionId: firstRecord.id,
    quote: firstQuote.body.quote,
    walletAddress: WALLET,
  });
  assert(old.status === 409 && old.body.code === "target_superseded", "superseded target purchase cannot be validated");
  assert(decisions[0].execution_status !== "awaiting_signature", "superseded purchase is not signable");
  const secondQuote = await post(quoteRoute, "/api/quote", {
    decisionId: secondRecord.id,
    walletAddress: WALLET,
  });
  const current = await post(validateRoute, "/api/execute/validate", {
    decisionId: secondRecord.id,
    quote: secondQuote.body.quote,
    walletAddress: WALLET,
  });
  assert(current.status === 200, "the active target purchase validates");
}

console.log("target flow ok");
