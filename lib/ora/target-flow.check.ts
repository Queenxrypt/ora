process.env.SUPABASE_URL = "http://supabase.test";
process.env.SUPABASE_SECRET_KEY = "test-secret";
process.env.ROBINHOOD_RPC_URL = "http://rpc.test";
process.env.ORBIO_MARKET_ORIGIN = "http://orbio.test";

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
import type { ExecutableQuote, MarketSnapshot } from "../../types/ora";

const { beneficiaryBytes32, exchangeAbi } = await import("../orbio/exchange");
const { CONTRACTS } = await import("../orbio/contracts");
const { fulfillTargetFromDecision } = await import("../db/targets");

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
    return encodeFunctionResult({
      abi: exchangeAbi,
      functionName: "getQuoteForCredit",
      result: {
        creditOut: creditAtoms,
        usdgSpent: (creditAtoms * quoteUsdgBps) / 100n,
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
      };
      targets.push(row);
      return asObject ? json(row, 201) : json([row], 201);
    }
    if (method === "PATCH") {
      const found = filterTable(targets as unknown as Record<string, unknown>[], url) as unknown as TargetRow[];
      const patch = JSON.parse(String(init?.body)) as Partial<TargetRow>;
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
const { evaluateOpenTargetsAfterObservation } = await import("./watch-targets");

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

console.log("target flow ok");
