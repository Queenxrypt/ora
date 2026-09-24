import { encodeFunctionData, type Hex } from "viem";
import type { DecisionRow } from "../db/rows";
import type { ExecutionStatus } from "../../types/ora";

process.env.SUPABASE_URL = "http://supabase.test";
process.env.SUPABASE_SECRET_KEY = "test-secret";
process.env.ROBINHOOD_RPC_URL = "http://rpc.test";

const { exchangeAbi, beneficiaryBytes32 } = await import("./exchange");

function assert(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}

// Real Robinhood Chain 4663 buyAndActivate (0x812e…ae39) from eth_getTransactionByHash
// and eth_getTransactionReceipt.
const WALLET = "0x5202d9b5a43448f939091eb25e6a7816aef3917d" as const;
const OTHER_WALLET = "0x63fc81ed1e1eab3e2906b578ccd3097970852a1b" as const;
const EXCHANGE = "0x6951ffd32630b05e06f50062aea801625a58ebc0";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const TX1 = "0x812e164de5034c0dba7dd97d76bb1924efe10269bb18d47831d7289ae001ae39" as const;
const TX1_INPUT: Hex =
  "0x6ebadb6e00000000000000000000000000000000000000000000000000000000000f4240000000000000000000000000000000000000000000000000000000000014243f0000000000000000000000005202d9b5a43448f939091eb25e6a7816aef3917d0000000000000000000000000000000000000000000000000000000000000008";

const rawTx1 = {
  blockHash: "0x1ff619b778e0a6c72782f817a7211fe3308f30a439af73a4d3eee8cd55bd85ba",
  blockNumber: "0x434a237",
  from: WALLET,
  gas: "0x37cfe",
  gasPrice: "0x3034550",
  maxFeePerGas: "0x5f75800",
  maxPriorityFeePerGas: "0x0",
  hash: TX1,
  input: TX1_INPUT,
  nonce: "0x9",
  to: EXCHANGE,
  transactionIndex: "0x1",
  value: "0x0",
  type: "0x2",
  accessList: [],
  chainId: "0x1237",
  v: "0x0",
  r: "0xabd15a64fec430bb154a9512b64744e76d38ac6a6059eed0993b923f1e38a0ee",
  s: "0x217fcabcfce51e49ca10fd237826ec33fdc80d60936e8100a00678086e3ba53",
  yParity: "0x0",
};

const TX1_LOGS = [
  {
    address: EXCHANGE,
    topics: [
      "0x76fe732858ddd73f56d6b5cbcb0acd96d226bb2c44399ea5b5c8a6f3e18b7617",
      "0x0000000000000000000000000000000000000000000000000000009600000047",
      "0x000000000000000000000000ee59986443da8fdb1e89f0ca82fae4702a9545a6",
      "0x0000000000000000000000005202d9b5a43448f939091eb25e6a7816aef3917d",
    ],
    data: "0x000000000000000000000000000000000000000000000000000000000014585500000000000000000000000000000000000000000000000000000000000f42400000000000000000000000000000000000000000000000000000000000000000",
    logIndex: "0x0",
    removed: false,
  },
  {
    address: EXCHANGE,
    topics: [
      "0x2683a506cc521e11c368ce9c068585a91786a3cb7ab4089b602eb2835acb1639",
      "0x0000000000000000000000005202d9b5a43448f939091eb25e6a7816aef3917d",
      "0x0000000000000000000000006951ffd32630b05e06f50062aea801625a58ebc0",
    ],
    data: "0x000000000000000000000000000000000000000000000000000000000014585500000000000000000000000000000000000000000000000000000000000f424000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001",
    logIndex: "0x1",
    removed: false,
  },
  {
    address: USDG,
    topics: [
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
      "0x0000000000000000000000005202d9b5a43448f939091eb25e6a7816aef3917d",
      "0x0000000000000000000000006951ffd32630b05e06f50062aea801625a58ebc0",
    ],
    data: "0x00000000000000000000000000000000000000000000000000000000000f4240",
    logIndex: "0x2",
    removed: false,
  },
];

function rawReceipt(hash: Hex) {
  return {
    blockHash: rawTx1.blockHash,
    blockNumber: rawTx1.blockNumber,
    contractAddress: null,
    cumulativeGasUsed: "0x2a0c2",
    effectiveGasPrice: "0x3034550",
    from: WALLET,
    gasUsed: "0x2a0c2",
    logs: TX1_LOGS.map((log) => ({
      ...log,
      blockNumber: rawTx1.blockNumber,
      blockHash: rawTx1.blockHash,
      transactionHash: hash,
      transactionIndex: "0x1",
    })),
    logsBloom: `0x${"0".repeat(512)}`,
    status: "0x1",
    to: EXCHANGE,
    transactionHash: hash,
    transactionIndex: "0x1",
    type: "0x2",
  };
}

function mempoolTx(hash: Hex, overrides: Record<string, unknown> = {}) {
  return { ...rawTx1, hash, blockHash: null, blockNumber: null, transactionIndex: null, ...overrides };
}

// ---------------------------------------------------------------------------
// In-memory JSON-RPC and PostgREST.
// ---------------------------------------------------------------------------

const chain = new Map<string, { tx: unknown | null; receipt: unknown | null }>();
let rows: DecisionRow[] = [];
const calls = { writes: 0, rpc: 0 };

function matches(row: DecisionRow, column: string, expr: string): boolean {
  const value = (row as Record<string, unknown>)[column];
  const dot = expr.indexOf(".");
  const op = expr.slice(0, dot);
  const arg = expr.slice(dot + 1);
  if (op === "eq") return value != null && String(value) === arg;
  if (op === "neq") return value != null && String(value) !== arg;
  if (op === "is" && arg === "null") return value == null;
  if (op === "ilike") {
    if (value == null) return false;
    const re = new RegExp(`^${arg.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/[%*]/g, ".*")}$`, "i");
    return re.test(String(value));
  }
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

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const method = (init?.method ?? "GET").toUpperCase();
  if (url.host === "rpc.test") {
    calls.rpc += 1;
    const req = JSON.parse(String(init?.body)) as { id: number; method: string; params: string[] };
    const entry = chain.get(String(req.params[0]).toLowerCase());
    if (req.method === "eth_getTransactionByHash") {
      return json({ jsonrpc: "2.0", id: req.id, result: entry?.tx ?? null });
    }
    if (req.method === "eth_getTransactionReceipt") {
      return json({ jsonrpc: "2.0", id: req.id, result: entry?.receipt ?? null });
    }
    throw new Error(`fake rpc: unexpected ${req.method}`);
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

const confirmRoute = await import("../../app/api/execute/confirm/route");
const receiptRoute = await import("../../app/api/execute/receipt/route");

function decisionRow(id: string, overrides: Partial<DecisionRow> = {}): DecisionRow {
  return {
    id,
    wallet_address: WALLET,
    timestamp: "2026-09-23T15:00:00.000Z",
    market: { price: 0.75, discountPercent: 25, availableDepth: 80 },
    snapshot: {
      timestamp: "2026-09-23T15:00:00.000Z",
      creditPrice: 0.75,
      discountPercent: 25,
      bestDiscount: 25,
      availableAtBestDiscount: 80,
      depth: [{ discountPercent: 25, availableCredit: 80 }],
      source: "orbio",
      totalAvailableCredit: 80,
      minBuyCredit: 1,
    },
    decision: "BUY",
    reason: "fixture",
    requested_amount: 1.333333,
    quote_price: 0.75,
    quoted_usdg: 1,
    quoted_at: "2026-09-23T15:00:00.000Z",
    validated_block: 0x434a236,
    execution_price: null,
    tx_hash: null,
    execution_status: "awaiting_signature",
    blocked_reason: null,
    credit_acquired: null,
    total_usdg_paid: null,
    confirmed_at: null,
    reasoning: null,
    ...overrides,
  };
}

function hashOf(n: number): `0x${string}` {
  return `0x${n.toString(16).padStart(64, "0")}`;
}

function row(id: string): DecisionRow {
  const found = rows.find((r) => r.id === id);
  assert(found, `row ${id} exists`);
  return found;
}

async function post(
  route: { POST: (request: Request) => Promise<Response> },
  body: Record<string, unknown>,
) {
  const res = await route.POST(
    new Request("http://localhost/api/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const confirm = (body: Record<string, unknown>) => post(confirmRoute, body);
const receipt = (body: Record<string, unknown>) => post(receiptRoute, body);

async function expectNoWrite(
  label: string,
  id: string,
  run: () => Promise<{ status: number; body: Record<string, unknown> }>,
) {
  const snapshot = JSON.stringify(row(id));
  const writes = calls.writes;
  const result = await run();
  assert(JSON.stringify(row(id)) === snapshot, `${label}: decision unchanged`);
  assert(calls.writes === writes, `${label}: no update issued`);
  return result;
}

// Malformed hash -> 400, no write, no chain read.
for (const bad of [
  "not-a-hash",
  "0x1234",
  `0x${"g".repeat(64)}`,
  `${"a".repeat(64)}`,
  `0x${"a".repeat(65)}`,
  12345,
  null,
]) {
  rows = [decisionRow("m1")];
  const rpc = calls.rpc;
  const r = await expectNoWrite(`malformed ${String(bad)}`, "m1", () =>
    confirm({ decisionId: "m1", txHash: bad, walletAddress: WALLET }),
  );
  assert(r.status === 400, `malformed ${String(bad)}: 400`);
  assert(calls.rpc === rpc, `malformed ${String(bad)}: no chain read`);
}

// Every non-signable status -> 409, unchanged.
const nonSignable: (ExecutionStatus | null)[] = [
  null,
  "none",
  "quoting",
  "review",
  "validating",
  "failed",
  "stale_quote",
  "blocked_limit",
  "blocked_liquidity",
  "blocked_funds",
];
chain.set(TX1, { tx: mempoolTx(TX1), receipt: null });
for (const status of nonSignable) {
  rows = [decisionRow("s1", { execution_status: status })];
  const r = await expectNoWrite(`${status}`, "s1", () =>
    confirm({ decisionId: "s1", txHash: TX1, walletAddress: WALLET }),
  );
  assert(r.status === 409 && r.body.code === "not_signable", `${status}: 409 not_signable`);
}

// Pending with no stored hash is not a state confirm can attach to.
{
  rows = [decisionRow("s2", { execution_status: "pending" })];
  const r = await expectNoWrite("pending without hash", "s2", () =>
    confirm({ decisionId: "s2", txHash: TX1, walletAddress: WALLET }),
  );
  assert(r.status === 409, "pending without hash: 409");
}

// Confirmed decision returns the stored record unchanged.
{
  rows = [
    decisionRow("c1", {
      execution_status: "success",
      tx_hash: TX1,
      credit_acquired: 1.333333,
      total_usdg_paid: 1,
      execution_price: 0.75,
      confirmed_at: "2026-09-23T15:05:00.000Z",
    }),
  ];
  const r = await expectNoWrite("success", "c1", () =>
    confirm({ decisionId: "c1", txHash: hashOf(0xc1), walletAddress: WALLET }),
  );
  assert(r.status === 200 && r.body.status === "success", "success: stored record returned");
}

// Pending H + different X -> 409, H preserved.
{
  rows = [decisionRow("p1", { execution_status: "pending", tx_hash: TX1 })];
  const x = hashOf(0xbad);
  chain.set(x, { tx: mempoolTx(x), receipt: null });
  const r = await expectNoWrite("pending H + X", "p1", () =>
    confirm({ decisionId: "p1", txHash: x, walletAddress: WALLET }),
  );
  assert(r.status === 409 && r.body.code === "tx_mismatch", "pending H + X: 409 tx_mismatch");
  assert(row("p1").tx_hash === TX1, "pending H + X: H preserved");
}

// A different stored hash on any other status is also never overwritten.
{
  rows = [decisionRow("p2", { execution_status: "awaiting_signature", tx_hash: TX1 })];
  const x = hashOf(0xbad);
  const r = await expectNoWrite("stored H + X", "p2", () =>
    confirm({ decisionId: "p2", txHash: x, walletAddress: WALLET }),
  );
  assert(r.status === 409 && row("p2").tx_hash === TX1, "stored H + X: H preserved");
}

// Pending H + H -> idempotent, including a differently cased resubmission.
{
  rows = [decisionRow("p3", { execution_status: "pending", tx_hash: TX1 })];
  const r = await expectNoWrite("pending H + H", "p3", () =>
    confirm({ decisionId: "p3", txHash: TX1, walletAddress: WALLET }),
  );
  assert(r.status === 200 && r.body.status === "pending", "pending H + H: ok");
  const upper = `0x${TX1.slice(2).toUpperCase()}`;
  const u = await expectNoWrite("pending H + upper H", "p3", () =>
    confirm({ decisionId: "p3", txHash: upper, walletAddress: WALLET }),
  );
  assert(u.status === 200 && u.body.status === "pending", "pending H + upper H: ok");
}

// awaiting_signature + hash the node has not seen -> 202, no write.
{
  rows = [decisionRow("u1")];
  const unseen = hashOf(0x5eed);
  const r = await expectNoWrite("unseen", "u1", () =>
    confirm({ decisionId: "u1", txHash: unseen, walletAddress: WALLET }),
  );
  assert(r.status === 202 && r.body.status === "pending", "unseen: 202 pending");
  assert(row("u1").tx_hash == null && row("u1").execution_status === "awaiting_signature", "unseen: hash not stored");
}

// Visible but invalid transactions -> rejected, no write.
{
  const invalid: [string, number, Record<string, unknown>, number, string][] = [
    ["wrong sender", 0x101, { from: OTHER_WALLET }, 403, "sender"],
    ["wrong destination", 0x102, { to: USDG }, 409, "destination"],
    ["wrong selector", 0x103, { input: `0xdeadbeef${TX1_INPUT.slice(10)}` }, 409, "selector"],
    [
      "other exchange function",
      0x104,
      {
        input: encodeFunctionData({
          abi: exchangeAbi,
          functionName: "buy",
          args: [1_000_000n, 1_319_999n, WALLET, 8n],
        }),
      },
      409,
      "selector",
    ],
    [
      "beneficiary is another account",
      0x105,
      {
        input: encodeFunctionData({
          abi: exchangeAbi,
          functionName: "buyAndActivate",
          args: [1_000_000n, 1_319_999n, beneficiaryBytes32(OTHER_WALLET), 8n],
        }),
      },
      409,
      "beneficiary",
    ],
    [
      "budget above validated quote",
      0x106,
      {
        input: encodeFunctionData({
          abi: exchangeAbi,
          functionName: "buyAndActivate",
          args: [2_000_000n, 1_319_999n, beneficiaryBytes32(WALLET), 8n],
        }),
      },
      409,
      "amount",
    ],
    [
      "budget below validated quote",
      0x107,
      {
        input: encodeFunctionData({
          abi: exchangeAbi,
          functionName: "buyAndActivate",
          args: [999_999n, 1_319_999n, beneficiaryBytes32(WALLET), 8n],
        }),
      },
      409,
      "amount",
    ],
  ];
  for (const [label, n, overrides, status, code] of invalid) {
    const h = hashOf(n);
    chain.set(h, { tx: mempoolTx(h, overrides), receipt: null });
    rows = [decisionRow("v1")];
    const r = await expectNoWrite(label, "v1", () =>
      confirm({ decisionId: "v1", txHash: h, walletAddress: WALLET }),
    );
    assert(r.status === status && r.body.code === code, `${label}: ${status} ${code} (got ${r.status} ${String(r.body.code)})`);
  }
}

// Visible valid buyAndActivate -> pending with the lowercase hash.
{
  rows = [decisionRow("ok1")];
  const upper = `0x${TX1.slice(2).toUpperCase()}`;
  const r = await confirm({ decisionId: "ok1", txHash: upper, walletAddress: WALLET });
  assert(r.status === 200 && r.body.status === "pending", "valid: 200 pending");
  assert(row("ok1").execution_status === "pending", "valid: status pending");
  assert(row("ok1").tx_hash === TX1, "valid: lowercase hash stored");
}

// Hash already confirmed on another decision -> 409 tx_reused.
{
  rows = [
    decisionRow("done", {
      execution_status: "success",
      tx_hash: TX1,
      credit_acquired: 1.333333,
      total_usdg_paid: 1,
      execution_price: 0.75,
      confirmed_at: "2026-09-23T15:05:00.000Z",
    }),
    decisionRow("r1"),
  ];
  const r = await expectNoWrite("reused", "r1", () =>
    confirm({ decisionId: "r1", txHash: TX1, walletAddress: WALLET }),
  );
  assert(r.status === 409 && r.body.code === "tx_reused", "reused: 409 tx_reused");
}

// Attacker junk hashes, then the victim's real hash -> victim confirms, receipt succeeds.
{
  rows = [decisionRow("victim")];
  chain.set(TX1, { tx: mempoolTx(TX1), receipt: null });

  const junk = hashOf(0xdead);
  const j = await expectNoWrite("attacker junk", "victim", () =>
    confirm({ decisionId: "victim", txHash: junk, walletAddress: WALLET }),
  );
  assert(j.status === 202, "attacker junk: 202, not stored");

  const foreign = hashOf(0xf0);
  chain.set(foreign, { tx: mempoolTx(foreign, { from: OTHER_WALLET }), receipt: null });
  const f = await expectNoWrite("attacker foreign tx", "victim", () =>
    confirm({ decisionId: "victim", txHash: foreign, walletAddress: WALLET }),
  );
  assert(f.status === 403, "attacker foreign tx: rejected");

  const v = await confirm({ decisionId: "victim", txHash: TX1, walletAddress: WALLET });
  assert(v.status === 200 && row("victim").tx_hash === TX1, "victim: real hash recorded");

  const again = await expectNoWrite("attacker junk after victim", "victim", () =>
    confirm({ decisionId: "victim", txHash: junk, walletAddress: WALLET }),
  );
  assert(again.status === 409 && row("victim").tx_hash === TX1, "attacker junk after victim: H preserved");

  const pending = await receipt({ decisionId: "victim", txHash: TX1, walletAddress: WALLET });
  assert(pending.status === 202, "receipt before mining: pending");

  chain.set(TX1, { tx: rawTx1, receipt: rawReceipt(TX1) });
  const settled = await receipt({ decisionId: "victim", txHash: TX1, walletAddress: WALLET });
  assert(settled.status === 200 && settled.body.status === "success", "receipt: success");
  const done = row("victim");
  assert(done.execution_status === "success", "victim confirmed");
  assert(done.credit_acquired === 1.333333 && done.total_usdg_paid === 1 && done.execution_price === 0.75, "victim amounts from chain");
}

// Victim's hash not yet visible at confirm time: nothing stored, receipt still records it.
{
  rows = [decisionRow("late")];
  const h = hashOf(0x1a7e);
  const c = await expectNoWrite("late confirm", "late", () =>
    confirm({ decisionId: "late", txHash: h, walletAddress: WALLET }),
  );
  assert(c.status === 202, "late: confirm 202");
  chain.set(h, { tx: { ...rawTx1, hash: h }, receipt: rawReceipt(h) });
  const r = await receipt({ decisionId: "late", txHash: h, walletAddress: WALLET });
  assert(r.status === 200 && row("late").execution_status === "success" && row("late").tx_hash === h, "late: receipt confirms");
}

console.log("confirm route ok");
