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
import type { ExecutableQuote, ExecutionStatus } from "../../types/ora";

process.env.SUPABASE_URL = "http://supabase.test";
process.env.SUPABASE_SECRET_KEY = "test-secret";
process.env.ROBINHOOD_RPC_URL = "http://rpc.test";
process.env.ORBIO_MARKET_ORIGIN = "http://orbio.test";

const { exchangeAbi, beneficiaryBytes32 } = await import("./exchange");

function assert(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}

const WALLET = "0x5202d9b5a43448f939091eb25e6a7816aef3917d" as const;
const EXCHANGE = "0x6951ffd32630b05e06f50062aea801625a58ebc0" as const;
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";

// Book: 80 CREDIT at 25%, 100 at 10%, 5 CREDIT minimum. Default params -> BUY 5 for 3.75 USDG.
const book = {
  rows: [
    { discountBps: 2500, microUsd: "80000000" },
    { discountBps: 1000, microUsd: "100000000" },
  ],
  totalMicroUsd: "180000000",
  minBuyMicroUsd: "5000000",
};
const QUOTED_USDG_ATOMS = 3_750_000n;
const CREDIT_ATOMS = 5_000_000n;

// ---------------------------------------------------------------------------
// Chain fixtures
// ---------------------------------------------------------------------------

function buyInput(usdgIn: bigint = QUOTED_USDG_ATOMS): Hex {
  return encodeFunctionData({
    abi: exchangeAbi,
    functionName: "buyAndActivate",
    args: [usdgIn, 4_900_000n, beneficiaryBytes32(WALLET), 32n],
  });
}

function toHex(n: number): Hex {
  return `0x${n.toString(16)}`;
}

function rawTx(hash: Hex, input: Hex, block: number | null) {
  return {
    blockHash: block == null ? null : `0x${"11".repeat(32)}`,
    blockNumber: block == null ? null : toHex(block),
    from: WALLET,
    gas: "0x37cfe",
    gasPrice: "0x3034550",
    maxFeePerGas: "0x5f75800",
    maxPriorityFeePerGas: "0x0",
    hash,
    input,
    nonce: "0x9",
    to: EXCHANGE,
    transactionIndex: block == null ? null : "0x1",
    value: "0x0",
    type: "0x2",
    accessList: [],
    chainId: "0x1237",
    v: "0x0",
    r: "0xabd15a64fec430bb154a9512b64744e76d38ac6a6059eed0993b923f1e38a0ee",
    s: "0x217fcabcfce51e49ca10fd237826ec33fdc80d60936e8100a00678086e3ba53",
    yParity: "0x0",
  };
}

const boughtEvent = parseAbiItem(
  "event Bought(address indexed buyer, address indexed recipient, uint256 creditOut, uint256 usdgSpent, uint256 feeAtoms, uint256 fills)",
);
const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

function rawReceipt(hash: Hex, block: number, usdgSpent: bigint = QUOTED_USDG_ATOMS) {
  const logs = [
    {
      address: EXCHANGE,
      topics: encodeEventTopics({
        abi: [boughtEvent],
        eventName: "Bought",
        args: { buyer: WALLET, recipient: EXCHANGE },
      }),
      data: encodeAbiParameters(
        [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
        [CREDIT_ATOMS, usdgSpent, 0n, 1n],
      ),
    },
    {
      address: USDG,
      topics: encodeEventTopics({
        abi: [transferEvent],
        eventName: "Transfer",
        args: { from: WALLET, to: EXCHANGE },
      }),
      data: encodeAbiParameters([{ type: "uint256" }], [usdgSpent]),
    },
  ];
  return {
    blockHash: `0x${"11".repeat(32)}`,
    blockNumber: toHex(block),
    contractAddress: null,
    cumulativeGasUsed: "0x2a0c2",
    effectiveGasPrice: "0x3034550",
    from: WALLET,
    gasUsed: "0x2a0c2",
    logs: logs.map((log, i) => ({
      ...log,
      logIndex: toHex(i),
      removed: false,
      blockNumber: toHex(block),
      blockHash: `0x${"11".repeat(32)}`,
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

const chain = new Map<string, { tx: unknown | null; receipt: unknown | null }>();

function mempool(hash: Hex, input: Hex = buyInput()) {
  chain.set(hash, { tx: rawTx(hash, input, null), receipt: null });
}

function mine(hash: Hex, block: number, input: Hex = buyInput()) {
  chain.set(hash, { tx: rawTx(hash, input, block), receipt: rawReceipt(hash, block) });
}

function hashOf(n: number): Hex {
  return `0x${n.toString(16).padStart(64, "0")}`;
}

// ---------------------------------------------------------------------------
// In-memory Orbio market, JSON-RPC and PostgREST.
// ---------------------------------------------------------------------------

let rows: DecisionRow[] = [];
let head: number | null = 1_000;
const calls = { writes: 0 };

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

function ethCall(data: Hex): Hex {
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
  if (url.host === "orbio.test" && url.pathname === "/api/market/book") return json(book);
  if (url.host === "rpc.test") {
    const req = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
    const rpc = (result: unknown) => json({ jsonrpc: "2.0", id: req.id, result });
    if (req.method === "eth_blockNumber") {
      if (head == null) {
        return json({ jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "unavailable" } });
      }
      return rpc(toHex(head));
    }
    if (req.method === "eth_call") return rpc(ethCall((req.params[0] as { data: Hex }).data));
    const entry = chain.get(String(req.params[0]).toLowerCase());
    if (req.method === "eth_getTransactionByHash") return rpc(entry?.tx ?? null);
    if (req.method === "eth_getTransactionReceipt") return rpc(entry?.receipt ?? null);
    throw new Error(`fake rpc: unexpected ${req.method}`);
  }
  if (url.host === "supabase.test" && url.pathname === "/rest/v1/settings") return json([]);
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
    execution_status: null,
    blocked_reason: null,
    credit_acquired: null,
    total_usdg_paid: null,
    confirmed_at: null,
    reasoning: null,
    ...overrides,
  };
}

/** A decision as validate leaves it: 3.75 USDG quote, chain head 1000. */
function signable(id: string, overrides: Partial<DecisionRow> = {}) {
  return decisionRow(id, {
    quote_price: 0.75,
    quoted_usdg: 3.75,
    quoted_at: "2026-09-23T15:00:00.000Z",
    validated_block: 1_000,
    execution_status: "awaiting_signature",
    ...overrides,
  });
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
      body: JSON.stringify({ walletAddress: WALLET, ...body }),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

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

async function quoteAndValidate(id: string) {
  const quoted = await post(quoteRoute, { decisionId: id });
  assert(quoted.status === 200, `quote ${id} (got ${quoted.status}: ${JSON.stringify(quoted.body)})`);
  return post(validateRoute, { decisionId: id, quote: quoted.body.quote });
}

// ---------------------------------------------------------------------------
// Normal flow: quote -> validate -> confirm -> receipt -> success.
// ---------------------------------------------------------------------------
{
  head = 1_000;
  rows = [decisionRow("flow")];
  const v = await quoteAndValidate("flow");
  assert(v.status === 200, `flow: validate ok (got ${v.status}: ${JSON.stringify(v.body)})`);
  const quote = v.body.quote as ExecutableQuote;
  assert(BigInt(quote.usdgIn) === QUOTED_USDG_ATOMS, "flow: quote usdgIn is 3.75 USDG");
  assert(row("flow").execution_status === "awaiting_signature", "flow: awaiting_signature");
  assert(row("flow").validated_block === 1_000, "flow: validated_block is the chain head");

  const h = hashOf(0xf10);
  mempool(h);
  const c = await post(confirmRoute, { decisionId: "flow", txHash: h });
  assert(c.status === 200 && c.body.status === "pending", "flow: confirm records pending");
  assert(row("flow").tx_hash === h && row("flow").execution_status === "pending", "flow: hash stored");

  head = 1_001;
  mine(h, 1_001);
  const r = await post(receiptRoute, { decisionId: "flow", txHash: h });
  assert(r.status === 200 && r.body.status === "success", `flow: receipt success (got ${r.status}: ${JSON.stringify(r.body)})`);
  const done = row("flow");
  assert(done.execution_status === "success", "flow: success");
  assert(done.credit_acquired === 5 && done.total_usdg_paid === 3.75 && done.execution_price === 0.75, "flow: amounts from chain");
}

// ---------------------------------------------------------------------------
// A pre-existing external purchase (same wallet, same amount) cannot confirm a later decision.
// ---------------------------------------------------------------------------
{
  const external = hashOf(0xe07);
  mine(external, 990);
  const atHead = hashOf(0xe08);
  mine(atHead, 1_000);

  head = 1_000;
  rows = [decisionRow("ext")];
  const v = await quoteAndValidate("ext");
  assert(v.status === 200 && row("ext").validated_block === 1_000, "ext: validated at head 1000");

  for (const [label, h] of [["mined before", external], ["mined at", atHead]] as const) {
    const c = await expectNoWrite(`ext confirm ${label}`, "ext", () =>
      post(confirmRoute, { decisionId: "ext", txHash: h }),
    );
    assert(c.status === 409 && c.body.code === "block", `ext confirm ${label}: 409 block (got ${c.status} ${String(c.body.code)})`);

    const r = await expectNoWrite(`ext receipt ${label}`, "ext", () =>
      post(receiptRoute, { decisionId: "ext", txHash: h }),
    );
    assert(r.status === 409 && r.body.code === "block", `ext receipt ${label}: 409 block (got ${r.status} ${String(r.body.code)})`);
    assert(row("ext").execution_status === "awaiting_signature", `ext ${label}: still awaiting_signature`);
  }

  // Even a stored pending hash cannot settle with an old transaction.
  rows = [signable("ext2", { tx_hash: external, execution_status: "pending" })];
  const r = await expectNoWrite("ext pending old hash", "ext2", () =>
    post(receiptRoute, { decisionId: "ext2", txHash: external }),
  );
  assert(r.status === 409 && r.body.code === "block", "ext pending old hash: 409 block");

  // The user's own purchase after validation still settles the decision.
  const own = hashOf(0xe09);
  mine(own, 1_001);
  rows = [signable("ext3")];
  const ok = await post(receiptRoute, { decisionId: "ext3", txHash: own });
  assert(ok.status === 200 && row("ext3").execution_status === "success", "ext: own later purchase confirms");
}

// ---------------------------------------------------------------------------
// Confirm: already-mined transactions and the unseen 202.
// ---------------------------------------------------------------------------
{
  const unseen = hashOf(0xc00);
  rows = [signable("c-unseen")];
  const u = await expectNoWrite("confirm unseen", "c-unseen", () =>
    post(confirmRoute, { decisionId: "c-unseen", txHash: unseen }),
  );
  assert(u.status === 202 && u.body.status === "pending", "confirm unseen: 202 pending");

  const after = hashOf(0xc01);
  mine(after, 1_001);
  rows = [signable("c-after")];
  const a = await post(confirmRoute, { decisionId: "c-after", txHash: after });
  assert(a.status === 200 && a.body.status === "pending", "confirm mined after: 200 pending");
  assert(row("c-after").tx_hash === after && row("c-after").execution_status === "pending", "confirm mined after: hash stored");
  const settled = await post(receiptRoute, { decisionId: "c-after", txHash: after });
  assert(settled.status === 200 && row("c-after").execution_status === "success", "confirm mined after: receipt succeeds");

  const early = hashOf(0xc02);
  mine(early, 1_000);
  rows = [signable("c-early")];
  const e = await expectNoWrite("confirm mined at validated block", "c-early", () =>
    post(confirmRoute, { decisionId: "c-early", txHash: early }),
  );
  assert(e.status === 409 && e.body.code === "block", "confirm mined at validated block: 409 block");

  const legacy = hashOf(0xc03);
  mine(legacy, 1_001);
  rows = [signable("c-legacy", { validated_block: null })];
  const l = await expectNoWrite("confirm mined, no validated block", "c-legacy", () =>
    post(confirmRoute, { decisionId: "c-legacy", txHash: legacy }),
  );
  assert(l.status === 409 && l.body.code === "unvalidated", "confirm mined, no validated block: 409 unvalidated");
}

// ---------------------------------------------------------------------------
// Receipt lifecycle gate. A valid purchase mined after validation is available throughout.
// ---------------------------------------------------------------------------
{
  const valid = hashOf(0x6a7e);
  mine(valid, 1_001);

  const noHash: (ExecutionStatus | null)[] = [
    null,
    "none",
    "quoting",
    "review",
    "validating",
    "pending",
    "failed",
    "stale_quote",
    "blocked_limit",
    "blocked_liquidity",
    "blocked_funds",
  ];
  for (const status of noHash) {
    rows = [signable("g", { execution_status: status })];
    const r = await expectNoWrite(`gate ${status} no hash`, "g", () =>
      post(receiptRoute, { decisionId: "g", txHash: valid }),
    );
    assert(r.status === 409 && r.body.code === "not_receivable", `gate ${status} no hash: 409 not_receivable`);
  }

  const withHash: (ExecutionStatus | null)[] = noHash
    .filter((s) => s !== "pending")
    .concat(["awaiting_signature"]);
  for (const status of withHash) {
    rows = [signable("g", { execution_status: status, tx_hash: valid })];
    const r = await expectNoWrite(`gate ${status} + hash`, "g", () =>
      post(receiptRoute, { decisionId: "g", txHash: valid }),
    );
    assert(r.status === 409 && r.body.code === "not_receivable", `gate ${status} + hash: 409 not_receivable`);
  }

  rows = [signable("g", { execution_status: "pending", tx_hash: valid })];
  const other = await expectNoWrite("gate pending + other hash", "g", () =>
    post(receiptRoute, { decisionId: "g", txHash: hashOf(0x07e) }),
  );
  assert(other.status === 409, "gate pending + other hash: 409");

  rows = [signable("g", { validated_block: null })];
  const legacy = await expectNoWrite("gate no validated block", "g", () =>
    post(receiptRoute, { decisionId: "g", txHash: valid }),
  );
  assert(legacy.status === 409 && legacy.body.code === "unvalidated", "gate no validated block: 409 unvalidated");

  rows = [signable("g")];
  const fromAwaiting = await post(receiptRoute, { decisionId: "g", txHash: valid });
  assert(fromAwaiting.status === 200 && row("g").execution_status === "success", "gate awaiting_signature, no hash: confirms");

  rows = [signable("g", { execution_status: "pending", tx_hash: valid })];
  const fromPending = await post(receiptRoute, { decisionId: "g", txHash: valid });
  assert(fromPending.status === 200 && row("g").execution_status === "success", "gate pending + same hash: confirms");
}

// ---------------------------------------------------------------------------
// usdgIn must equal the validated quote exactly.
// ---------------------------------------------------------------------------
for (const [label, usdgIn] of [
  ["one atom under", QUOTED_USDG_ATOMS - 1n],
  ["one atom over", QUOTED_USDG_ATOMS + 1n],
  ["half", QUOTED_USDG_ATOMS / 2n],
] as const) {
  const h = hashOf(0xa000 + Number(usdgIn % 0xfffn));
  chain.set(h, {
    tx: rawTx(h, buyInput(usdgIn), 1_001),
    receipt: rawReceipt(h, 1_001, usdgIn < QUOTED_USDG_ATOMS ? usdgIn : QUOTED_USDG_ATOMS),
  });
  rows = [signable("amt")];
  const c = await expectNoWrite(`amount ${label} confirm`, "amt", () =>
    post(confirmRoute, { decisionId: "amt", txHash: h }),
  );
  assert(c.status === 409 && c.body.code === "amount", `amount ${label}: confirm 409 amount`);
  const r = await expectNoWrite(`amount ${label} receipt`, "amt", () =>
    post(receiptRoute, { decisionId: "amt", txHash: h }),
  );
  assert(r.status === 409 && r.body.code === "amount", `amount ${label}: receipt 409 amount`);
}

console.log("execution integrity ok");
