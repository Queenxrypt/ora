import { decodeFunctionData, encodeFunctionResult, type Hex } from "viem";
import type { DecisionRow } from "../db/rows";
import type { ExecutableQuote, ExecutionStatus } from "../../types/ora";

process.env.SUPABASE_URL = "http://supabase.test";
process.env.SUPABASE_SECRET_KEY = "test-secret";
process.env.ROBINHOOD_RPC_URL = "http://rpc.test";
process.env.ORBIO_MARKET_ORIGIN = "http://orbio.test";

const { exchangeAbi } = await import("../orbio/exchange");
const { CONTRACTS } = await import("../orbio/contracts");

function assert(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}

const WALLET = "0x5202d9b5a43448f939091eb25e6a7816aef3917d";

// Book: 80 CREDIT at 25%, 100 at 10%, 5 CREDIT minimum. Default params -> BUY 5.
const book = {
  rows: [
    { discountBps: 2500, microUsd: "80000000" },
    { discountBps: 1000, microUsd: "100000000" },
  ],
  totalMicroUsd: "180000000",
  minBuyMicroUsd: "5000000",
};

let rows: DecisionRow[] = [];
const calls = { market: 0, rpc: 0, writes: 0 };
let head: number | null = 70_558_262;

function matches(row: DecisionRow, column: string, expr: string): boolean {
  const value = (row as Record<string, unknown>)[column];
  const dot = expr.indexOf(".");
  const op = expr.slice(0, dot);
  const arg = expr.slice(dot + 1);
  if (op === "eq") return value != null && String(value) === arg;
  if (op === "neq") return value != null && String(value) !== arg;
  if (op === "is" && arg === "null") return value == null;
  throw new Error(`fake postgrest: unsupported filter ${column}=${expr}`);
}

function filterRows(url: URL): DecisionRow[] {
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

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
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
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const method = (init?.method ?? "GET").toUpperCase();
  if (url.host === "orbio.test" && url.pathname === "/api/market/book") {
    calls.market += 1;
    return json(book);
  }
  if (url.host === "rpc.test") {
    calls.rpc += 1;
    const req = JSON.parse(String(init?.body)) as {
      id: number;
      method: string;
      params: [{ to: string; data: Hex }, string];
    };
    if (req.method === "eth_blockNumber") {
      if (head == null) {
        return json({ jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "unavailable" } });
      }
      return json({ jsonrpc: "2.0", id: req.id, result: `0x${head.toString(16)}` });
    }
    assert(req.method === "eth_call", `fake rpc: unexpected ${req.method}`);
    assert(req.params[0].to.toLowerCase() === CONTRACTS.exchange, "quote reads the exchange");
    return json({ jsonrpc: "2.0", id: req.id, result: rpcResult(req.params[0].data) });
  }
  if (url.host === "supabase.test" && url.pathname === "/rest/v1/settings") {
    return json([]);
  }
  if (url.host === "supabase.test" && url.pathname === "/rest/v1/decisions") {
    const found = filterRows(url);
    if (method === "GET") return json(found);
    if (method === "PATCH") {
      calls.writes += 1;
      const patch = JSON.parse(String(init?.body)) as Partial<DecisionRow>;
      for (const row of found) Object.assign(row, patch);
      return json(found.map((row) => ({ ...row })));
    }
  }
  throw new Error(`fake fetch: unexpected ${method} ${url.href}`);
}) as typeof fetch;

const quoteRoute = await import("../../app/api/quote/route");
const validateRoute = await import("../../app/api/execute/validate/route");

function decisionRow(status: ExecutionStatus | null): DecisionRow {
  return {
    id: "dec-1",
    wallet_address: WALLET,
    timestamp: "2026-09-23T15:00:00.000Z",
    market: { price: 0.75, discountPercent: 25, availableDepth: 80 },
    snapshot: {
      timestamp: "2026-09-23T15:00:00.000Z",
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
    },
    decision: "BUY",
    reason: "fixture",
    requested_amount: 5,
    quote_price: null,
    quoted_usdg: null,
    quoted_at: null,
    validated_block: null,
    execution_price: null,
    tx_hash: null,
    execution_status: status,
    blocked_reason: null,
    credit_acquired: null,
    total_usdg_paid: null,
    confirmed_at: null,
    reasoning: null,
  };
}

function statusOf(): ExecutionStatus | null {
  return rows[0].execution_status;
}

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

// Normal path: quote -> validate.
{
  rows = [decisionRow(null)];
  const quoted = await post(quoteRoute, "/api/quote", { decisionId: "dec-1", walletAddress: WALLET });
  assert(quoted.status === 200, `quote succeeds (got ${quoted.status}: ${JSON.stringify(quoted.body)})`);
  const quote = quoted.body.quote as ExecutableQuote;
  assert(quote.requestedCredit === 5 && quote.totalUsdg === 3.75, "quote is for the decided 5 CREDIT");
  assert(statusOf() === "review", "quote leaves the decision in review");

  const validated = await post(validateRoute, "/api/execute/validate", {
    decisionId: "dec-1",
    quote,
    walletAddress: WALLET,
  });
  assert(validated.status === 200, `validate succeeds (got ${validated.status}: ${JSON.stringify(validated.body)})`);
  const fresh = validated.body.quote as ExecutableQuote;
  assert(fresh.requestedCredit === 5 && fresh.totalUsdg === 3.75, "validate returns the live quote");
  assert(statusOf() === "awaiting_signature", "validate moves to awaiting_signature");
  assert(rows[0].quoted_usdg === 3.75, "validate records the validated total");
  assert(rows[0].validated_block === 70_558_262, "validate records the chain head as validated_block");

  // A second validate on the same decision is no longer signable.
  const snapshot = JSON.stringify(rows[0]);
  const before = { ...calls };
  const again = await post(validateRoute, "/api/execute/validate", {
    decisionId: "dec-1",
    quote: fresh,
    walletAddress: WALLET,
  });
  assert(again.status === 409 && again.body.code === "not_signable", "repeat validate rejected");
  assert(JSON.stringify(rows[0]) === snapshot, "repeat validate writes nothing");
  assert(calls.writes === before.writes, "repeat validate issues no update");
}

// Signable statuses from canReviewDecision still reach the live checks.
for (const status of [null, "none", "quoting", "review"] as const) {
  rows = [decisionRow(status)];
  const quoted = await post(quoteRoute, "/api/quote", { decisionId: "dec-1", walletAddress: WALLET });
  rows = [decisionRow(status)];
  const r = await post(validateRoute, "/api/execute/validate", {
    decisionId: "dec-1",
    quote: quoted.body.quote,
    walletAddress: WALLET,
  });
  assert(r.status === 200, `${status ?? "null"}: signable decision validates`);
  assert(statusOf() === "awaiting_signature", `${status ?? "null"}: moves to awaiting_signature`);
}

// Every non-signable status: 409, no write, no market or chain read.
const rejected: ExecutionStatus[] = [
  "validating",
  "awaiting_signature",
  "pending",
  "success",
  "failed",
  "stale_quote",
  "blocked_limit",
  "blocked_liquidity",
  "blocked_funds",
];
const staleQuote: ExecutableQuote = {
  quotedAt: new Date().toISOString(),
  requestedCredit: 5,
  creditOut: 5,
  usdgSpent: 3.75,
  feeAtoms: 0,
  totalUsdg: 3.75,
  fills: 1,
  reason: 0,
  quotePrice: 0.75,
  discountPercent: 25,
  minCreditOut: 4_900_000,
  usdgIn: 3_750_000,
  maxFills: 32,
};
for (const status of rejected) {
  const row = decisionRow(status);
  if (status === "success") {
    Object.assign(row, {
      tx_hash: `0x${"ab".repeat(32)}`,
      quoted_usdg: 3.75,
      credit_acquired: 5,
      total_usdg_paid: 3.75,
      execution_price: 0.75,
      confirmed_at: "2026-09-23T15:05:00.000Z",
    });
  }
  if (status === "pending") row.tx_hash = `0x${"cd".repeat(32)}`;
  rows = [row];
  const snapshot = JSON.stringify(row);
  const before = { ...calls };
  const r = await post(validateRoute, "/api/execute/validate", {
    decisionId: "dec-1",
    quote: staleQuote,
    walletAddress: WALLET,
  });
  assert(r.status === 409, `${status}: rejected with 409 (got ${r.status})`);
  assert(r.body.code === "not_signable", `${status}: not_signable code`);
  assert(!("quote" in r.body), `${status}: no quote offered`);
  assert(JSON.stringify(rows[0]) === snapshot, `${status}: decision unchanged`);
  assert(calls.writes === before.writes, `${status}: no update issued`);
  assert(calls.market === before.market && calls.rpc === before.rpc, `${status}: no market or chain read`);
}

// No chain head -> no signing: 502, not awaiting_signature, no validated_block.
{
  rows = [decisionRow("review")];
  const quoted = await post(quoteRoute, "/api/quote", { decisionId: "dec-1", walletAddress: WALLET });
  head = null;
  const r = await post(validateRoute, "/api/execute/validate", {
    decisionId: "dec-1",
    quote: quoted.body.quote,
    walletAddress: WALLET,
  });
  head = 70_558_262;
  assert(r.status === 502 && r.body.code === "chain_unavailable", "no block: 502 chain_unavailable");
  assert(!("quote" in r.body), "no block: no quote offered");
  assert(statusOf() !== "awaiting_signature", "no block: not signable");
  assert(rows[0].validated_block == null, "no block: validated_block stays null");
}

// Ownership is still checked first.
{
  rows = [{ ...decisionRow("review"), wallet_address: "0x63fc81ed1e1eab3e2906b578ccd3097970852a1b" }];
  const r = await post(validateRoute, "/api/execute/validate", {
    decisionId: "dec-1",
    quote: staleQuote,
    walletAddress: WALLET,
  });
  assert(r.status === 403, "foreign decision is forbidden");
}

console.log("validate lifecycle ok");
