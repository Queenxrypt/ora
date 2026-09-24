import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  parseAbiItem,
  type Hex,
} from "viem";
import type { DecisionRow } from "../db/rows";

process.env.SUPABASE_URL = "http://supabase.test";
process.env.SUPABASE_SECRET_KEY = "test-secret";
process.env.ROBINHOOD_RPC_URL = "http://rpc.test";

const {
  BUY_AND_ACTIVATE_SELECTOR,
  checkCallMatchesDecision,
  checkMinedAfterValidation,
  deriveExecution,
  verifyBuyAndActivateCall,
} = await import("./receipt");
const { CONTRACTS } = await import("./contracts");
const { exchangeAbi } = await import("./exchange");

function assert(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}

// ---------------------------------------------------------------------------
// Fixtures: Robinhood Chain 4663 buyAndActivate txs, copied from eth_getTransactionByHash
// and eth_getTransactionReceipt.
// ---------------------------------------------------------------------------

const WALLET = "0x5202d9b5a43448f939091eb25e6a7816aef3917d" as const;
const OTHER_WALLET = "0x63fc81ed1e1eab3e2906b578ccd3097970852a1b" as const;
const EXCHANGE = "0x6951ffd32630b05e06f50062aea801625a58ebc0";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const CREDIT = "0xe33322da1380e61e5ae5dfb21e7f62924c73004c";
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

type RawLog = {
  address: string;
  topics: Hex[];
  data: Hex;
  logIndex: string;
  removed: boolean;
};

const TX1_LOGS: RawLog[] = [
  {
    // OrderFilled(orderId, seller, buyer, creditAtoms, usdgAtoms, retail)
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
    // Bought(buyer, recipient = exchange, creditOut, usdgSpent, feeAtoms, fills)
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
    // USDG Transfer(wallet -> exchange, 1_000_000)
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
  {
    // CREDIT Transfer(exchange -> 0x0): burned into the activation
    address: CREDIT,
    topics: [
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
      "0x0000000000000000000000006951ffd32630b05e06f50062aea801625a58ebc0",
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    ],
    data: "0x0000000000000000000000000000000000000000000000000000000000145855",
    logIndex: "0x3",
    removed: false,
  },
  {
    address: CREDIT,
    topics: [
      "0x3a293632e41f6556f85d186d28ae95749534c2c9422cec0e1075886560ca7147",
      "0x00000000000000000000000000000000000000000000000000000000000001b7",
      "0x0000000000000000000000006951ffd32630b05e06f50062aea801625a58ebc0",
      "0x0000000000000000000000005202d9b5a43448f939091eb25e6a7816aef3917d",
    ],
    data: "0x0000000000000000000000000000000000000000000000000000000000145855",
    logIndex: "0x4",
    removed: false,
  },
  {
    address: CREDIT,
    topics: [
      "0x22bce9ab29f23f4818afa41ce0ca8cc1d23816cf4544e29580a53aead6f0176c",
      "0x00000000000000000000000000000000000000000000000000000000000001b7",
    ],
    data: "0x000000000000000000000000000000000000000000000000000000000001046b",
    logIndex: "0x5",
    removed: false,
  },
];

function rawReceipt(
  hash: Hex,
  opts: { status?: "0x1" | "0x0"; from?: string; to?: string; logs?: RawLog[] } = {},
) {
  return {
    blockHash: rawTx1.blockHash,
    blockNumber: rawTx1.blockNumber,
    contractAddress: null,
    cumulativeGasUsed: "0x2a0c2",
    effectiveGasPrice: "0x3034550",
    from: opts.from ?? WALLET,
    gasUsed: "0x2a0c2",
    logs: (opts.logs ?? TX1_LOGS).map((log) => ({
      ...log,
      blockNumber: rawTx1.blockNumber,
      blockHash: rawTx1.blockHash,
      transactionHash: hash,
      transactionIndex: "0x1",
    })),
    logsBloom: `0x${"0".repeat(512)}`,
    status: opts.status ?? "0x1",
    to: opts.to ?? EXCHANGE,
    transactionHash: hash,
    transactionIndex: "0x1",
    type: "0x2",
  };
}

// Second real purchase: another client, two fills, beneficiary is not the sender.
const TX2_SENDER = "0x6478bb0e2b64e961730fd2053b3195393420b7ae" as const;
const TX2_INPUT: Hex =
  "0x6ebadb6e00000000000000000000000000000000000000000000000000000000000f42400000000000000000000000000000000000000000000000000000000000137dea000000000000000000000000b470c6c4d6e4e065af4823ac4b33f0d0da9f1d1e0000000000000000000000000000000000000000000000000000000000000040";
const TX2_LOGS: RawLog[] = [
  {
    address: EXCHANGE,
    topics: [
      "0x76fe732858ddd73f56d6b5cbcb0acd96d226bb2c44399ea5b5c8a6f3e18b7617",
      "0x0000000000000000000000000000000000000000000000000000008c00000061",
      "0x000000000000000000000000e2eba6a5ddf2c0f1ddec262c466551f18396d43a",
      "0x0000000000000000000000006478bb0e2b64e961730fd2053b3195393420b7ae",
    ],
    data: "0x000000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000000",
    logIndex: "0x0",
    removed: false,
  },
  {
    address: EXCHANGE,
    topics: [
      "0x76fe732858ddd73f56d6b5cbcb0acd96d226bb2c44399ea5b5c8a6f3e18b7617",
      "0x0000000000000000000000000000000000000000000000000000009b00000025",
      "0x000000000000000000000000e4d16bb0db5af85cdac30956069d8abaf26c608e",
      "0x0000000000000000000000006478bb0e2b64e961730fd2053b3195393420b7ae",
    ],
    data: "0x000000000000000000000000000000000000000000000000000000000013b04a00000000000000000000000000000000000000000000000000000000000f423a0000000000000000000000000000000000000000000000000000000000000000",
    logIndex: "0x1",
    removed: false,
  },
  {
    address: EXCHANGE,
    topics: [
      "0x2683a506cc521e11c368ce9c068585a91786a3cb7ab4089b602eb2835acb1639",
      "0x0000000000000000000000006478bb0e2b64e961730fd2053b3195393420b7ae",
      "0x0000000000000000000000006951ffd32630b05e06f50062aea801625a58ebc0",
    ],
    data: "0x000000000000000000000000000000000000000000000000000000000013b05200000000000000000000000000000000000000000000000000000000000f424000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002",
    logIndex: "0x2",
    removed: false,
  },
  {
    address: USDG,
    topics: [
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
      "0x0000000000000000000000006478bb0e2b64e961730fd2053b3195393420b7ae",
      "0x0000000000000000000000006951ffd32630b05e06f50062aea801625a58ebc0",
    ],
    data: "0x00000000000000000000000000000000000000000000000000000000000f4240",
    logIndex: "0x3",
    removed: false,
  },
];

function asReceipt(raw: ReturnType<typeof rawReceipt>) {
  return {
    status: raw.status === "0x1" ? ("success" as const) : ("reverted" as const),
    from: raw.from,
    to: raw.to,
    logs: raw.logs,
  };
}

const boughtEvent = parseAbiItem(
  "event Bought(address indexed buyer, address indexed recipient, uint256 creditOut, uint256 usdgSpent, uint256 feeAtoms, uint256 fills)",
);
const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

function boughtLog(args: {
  buyer: `0x${string}`;
  recipient: `0x${string}`;
  creditOut: bigint;
  usdgSpent: bigint;
  feeAtoms?: bigint;
  fills?: bigint;
}): RawLog {
  return {
    address: EXCHANGE,
    topics: encodeEventTopics({
      abi: [boughtEvent],
      eventName: "Bought",
      args: { buyer: args.buyer, recipient: args.recipient },
    }) as Hex[],
    data: encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
      [args.creditOut, args.usdgSpent, args.feeAtoms ?? 0n, args.fills ?? 1n],
    ),
    logIndex: "0x1",
    removed: false,
  };
}

function usdgTransferLog(from: `0x${string}`, to: `0x${string}`, value: bigint): RawLog {
  return {
    address: USDG,
    topics: encodeEventTopics({
      abi: [transferEvent],
      eventName: "Transfer",
      args: { from, to },
    }) as Hex[],
    data: encodeAbiParameters([{ type: "uint256" }], [value]),
    logIndex: "0x2",
    removed: false,
  };
}

// ---------------------------------------------------------------------------
// Unit: calldata verification
// ---------------------------------------------------------------------------

assert(BUY_AND_ACTIVATE_SELECTOR === "0x6ebadb6e", "selector must match the onchain buyAndActivate");
assert(CONTRACTS.exchange === EXCHANGE, "fixture exchange must be Orbio's exchange");

const tx1 = { from: WALLET, to: EXCHANGE, input: TX1_INPUT };

{
  const ok = verifyBuyAndActivateCall(tx1, WALLET);
  assert(ok.ok, "G: real buyAndActivate must verify");
  assert(ok.call.usdgIn === 1_000_000n, "G: usdgIn decoded");
  assert(ok.call.minCreditOut === 1_319_999n, "G: minCreditOut decoded");
  assert(
    ok.call.beneficiary === `0x${"0".repeat(24)}${WALLET.slice(2)}`,
    "G: beneficiary decoded",
  );
  assert(ok.call.maxFills === 8n, "G: maxFills decoded");
  const checksum = verifyBuyAndActivateCall(
    { from: "0x5202D9b5A43448f939091eb25E6a7816aEf3917D", to: EXCHANGE.toUpperCase().replace("0X", "0x"), input: TX1_INPUT },
    WALLET,
  );
  assert(checksum.ok, "G: checksummed addresses still verify");
}

{
  const r = verifyBuyAndActivateCall(tx1, OTHER_WALLET);
  assert(!r.ok && r.code === "sender", "A: wrong sender rejected");
}

{
  const r = verifyBuyAndActivateCall({ ...tx1, to: USDG }, WALLET);
  assert(!r.ok && r.code === "destination", "B: wrong destination rejected");
  const n = verifyBuyAndActivateCall({ ...tx1, to: null }, WALLET);
  assert(!n.ok && n.code === "destination", "B: contract creation rejected");
}

{
  const wrong = `0xdeadbeef${TX1_INPUT.slice(10)}` as Hex;
  const r = verifyBuyAndActivateCall({ ...tx1, input: wrong }, WALLET);
  assert(!r.ok && r.code === "selector", "E: wrong selector rejected");
  const empty = verifyBuyAndActivateCall({ ...tx1, input: "0x" }, WALLET);
  assert(!empty.ok && empty.code === "selector", "E: empty calldata rejected");
}

const BUY_INPUT = encodeFunctionData({
  abi: exchangeAbi,
  functionName: "buy",
  args: [1_000_000n, 1_319_999n, WALLET, 8n],
});
{
  const r = verifyBuyAndActivateCall({ ...tx1, input: BUY_INPUT }, WALLET);
  assert(!r.ok && r.code === "selector", "F: another exchange function rejected");
}

{
  const trailing = `${TX1_INPUT}00` as Hex;
  const r = verifyBuyAndActivateCall({ ...tx1, input: trailing }, WALLET);
  assert(!r.ok && r.code === "calldata", "non-canonical calldata rejected");
  const short = TX1_INPUT.slice(0, 74) as Hex;
  const s = verifyBuyAndActivateCall({ ...tx1, input: short }, WALLET);
  assert(!s.ok && s.code === "calldata", "truncated calldata rejected");
}

// ---------------------------------------------------------------------------
// Unit: call vs decision
// ---------------------------------------------------------------------------

{
  const call = verifyBuyAndActivateCall(tx1, WALLET);
  assert(call.ok, "fixture");
  assert(checkCallMatchesDecision(call.call, { wallet: WALLET, quotedUsdg: 1 }).ok, "budget equal to validated quote");
  const over = checkCallMatchesDecision(call.call, { wallet: WALLET, quotedUsdg: 0.999999 });
  assert(!over.ok && over.code === "amount", "budget above validated quote rejected");
  const under = checkCallMatchesDecision(call.call, { wallet: WALLET, quotedUsdg: 1.000001 });
  assert(!under.ok && under.code === "amount", "budget below validated quote rejected");
  const underBig = checkCallMatchesDecision(call.call, { wallet: WALLET, quotedUsdg: 5 });
  assert(!underBig.ok && underBig.code === "amount", "budget far below validated quote rejected");
  const none = checkCallMatchesDecision(call.call, { wallet: WALLET });
  assert(!none.ok && none.code === "unvalidated", "unvalidated decision rejected");

  const tx2 = verifyBuyAndActivateCall({ from: TX2_SENDER, to: EXCHANGE, input: TX2_INPUT }, TX2_SENDER);
  assert(tx2.ok, "real tx2 decodes");
  const benef = checkCallMatchesDecision(tx2.call, { wallet: TX2_SENDER, quotedUsdg: 1 });
  assert(!benef.ok && benef.code === "beneficiary", "beneficiary for another account rejected");
}

// ---------------------------------------------------------------------------
// Unit: receipt derivation (K, L, M)
// ---------------------------------------------------------------------------

{
  const call = verifyBuyAndActivateCall(tx1, WALLET);
  assert(call.ok, "fixture");
  const d = deriveExecution(asReceipt(rawReceipt(TX1)), { wallet: WALLET, call: call.call });
  assert(d.ok, "K: real receipt derives");
  assert(d.execution.creditAtoms === 1_333_333n, "K: CREDIT from Bought.creditOut");
  assert(d.execution.creditAcquired === 1.333333, "K: CREDIT in units");
  assert(d.execution.usdgPaidAtoms === 1_000_000n, "L: USDG from Bought.usdgSpent + feeAtoms");
  assert(d.execution.totalUsdgPaid === 1, "L: USDG in units");
  assert(d.execution.executionPrice === 0.75, "M: price = paid / credit");
  assert(d.execution.fills === 1n, "fills decoded");

  const tx2 = verifyBuyAndActivateCall({ from: TX2_SENDER, to: EXCHANGE, input: TX2_INPUT }, TX2_SENDER);
  assert(tx2.ok, "fixture");
  const d2 = deriveExecution(
    asReceipt(rawReceipt(TX1, { from: TX2_SENDER, logs: TX2_LOGS })),
    { wallet: TX2_SENDER, call: tx2.call },
  );
  assert(d2.ok, "K: multi-fill receipt derives from the single Bought event");
  assert(d2.execution.creditAtoms === 1_290_322n, "K: multi-fill CREDIT is Bought total, not a fill");
  assert(d2.execution.usdgPaidAtoms === 1_000_000n, "L: multi-fill USDG");
  assert(d2.execution.executionPrice === Number((1 / 1.290322).toFixed(6)), "M: multi-fill price");

  const reverted = deriveExecution(asReceipt(rawReceipt(TX1, { status: "0x0", logs: [] })), { wallet: WALLET, call: call.call });
  assert(!reverted.ok && reverted.code === "reverted", "C: reverted receipt not derived");

  const noBought = deriveExecution(
    asReceipt(rawReceipt(TX1, { logs: TX1_LOGS.filter((_, i) => i !== 1) })),
    { wallet: WALLET, call: call.call },
  );
  assert(!noBought.ok && noBought.code === "event", "missing Bought rejected");

  const twoBought = deriveExecution(
    asReceipt(rawReceipt(TX1, { logs: [...TX1_LOGS, TX1_LOGS[1]] })),
    { wallet: WALLET, call: call.call },
  );
  assert(!twoBought.ok && twoBought.code === "event", "duplicate Bought rejected");

  const removed = deriveExecution(
    asReceipt(rawReceipt(TX1, { logs: TX1_LOGS.map((l, i) => (i === 1 ? { ...l, removed: true } : l)) })),
    { wallet: WALLET, call: call.call },
  );
  assert(!removed.ok && removed.code === "event", "removed (reorged) Bought ignored");

  const foreignBought = TX1_LOGS.map((l, i) =>
    i === 1 ? { ...l, address: CREDIT } : l,
  );
  const spoof = deriveExecution(asReceipt(rawReceipt(TX1, { logs: foreignBought })), { wallet: WALLET, call: call.call });
  assert(!spoof.ok && spoof.code === "event", "Bought emitted by another contract ignored");

  const otherBuyer = deriveExecution(
    asReceipt(
      rawReceipt(TX1, {
        logs: [
          boughtLog({ buyer: OTHER_WALLET, recipient: EXCHANGE, creditOut: 1_333_333n, usdgSpent: 1_000_000n }),
          usdgTransferLog(WALLET, EXCHANGE, 1_000_000n),
        ],
      }),
    ),
    { wallet: WALLET, call: call.call },
  );
  assert(!otherBuyer.ok && otherBuyer.code === "event", "Bought for another buyer rejected");

  const plainBuy = deriveExecution(
    asReceipt(
      rawReceipt(TX1, {
        logs: [
          boughtLog({ buyer: WALLET, recipient: WALLET, creditOut: 1_333_333n, usdgSpent: 1_000_000n }),
          usdgTransferLog(WALLET, EXCHANGE, 1_000_000n),
        ],
      }),
    ),
    { wallet: WALLET, call: call.call },
  );
  assert(!plainBuy.ok && plainBuy.code === "event", "F: Bought from plain buy() (recipient != exchange) rejected");

  const mismatch = deriveExecution(
    asReceipt(
      rawReceipt(TX1, {
        logs: [
          boughtLog({ buyer: WALLET, recipient: EXCHANGE, creditOut: 1_333_333n, usdgSpent: 1_000_000n }),
          usdgTransferLog(WALLET, EXCHANGE, 900_000n),
        ],
      }),
    ),
    { wallet: WALLET, call: call.call },
  );
  assert(!mismatch.ok && mismatch.code === "transfer", "L: Bought vs USDG debit mismatch rejected");

  const zero = deriveExecution(
    asReceipt(
      rawReceipt(TX1, {
        logs: [boughtLog({ buyer: WALLET, recipient: EXCHANGE, creditOut: 0n, usdgSpent: 0n })],
      }),
    ),
    { wallet: WALLET, call: { ...call.call, minCreditOut: 0n } },
  );
  assert(!zero.ok && zero.code === "empty", "M: zero CREDIT never produces a price");

  const overBudget = deriveExecution(
    asReceipt(
      rawReceipt(TX1, {
        logs: [
          boughtLog({ buyer: WALLET, recipient: EXCHANGE, creditOut: 1_333_333n, usdgSpent: 1_000_001n }),
          usdgTransferLog(WALLET, EXCHANGE, 1_000_001n),
        ],
      }),
    ),
    { wallet: WALLET, call: call.call },
  );
  assert(!overBudget.ok && overBudget.code === "amount", "paid above usdgIn rejected");
}

// ---------------------------------------------------------------------------
// Unit: mined strictly after validated_block
// ---------------------------------------------------------------------------

{
  assert(checkMinedAfterValidation(101n, 100).ok, "mined after validated block accepted");
  const same = checkMinedAfterValidation(100n, 100);
  assert(!same.ok && same.code === "block", "mined at validated block rejected");
  const before = checkMinedAfterValidation(99n, 100);
  assert(!before.ok && before.code === "block", "mined before validated block rejected");
  const unmined = checkMinedAfterValidation(null, 100);
  assert(!unmined.ok && unmined.code === "block", "unmined never passes");
  const none = checkMinedAfterValidation(101n, undefined);
  assert(!none.ok && none.code === "unvalidated", "missing validated block rejected");
}

console.log("receipt decoding ok");

// ---------------------------------------------------------------------------
// Route: real POST handlers + real store, over in-memory JSON-RPC and PostgREST.
// ---------------------------------------------------------------------------

type RpcEntry = { tx: unknown | null; receipt: unknown | null };
const chain = new Map<string, RpcEntry>();
let rows: DecisionRow[] = [];

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
    const re = new RegExp(
      `^${arg.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/[%*]/g, ".*")}$`,
      "i",
    );
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
        const any = parts.some((part) => {
          const dot = part.indexOf(".");
          return matches(row, part.slice(0, dot), part.slice(dot + 1));
        });
        if (!any) return false;
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
      const patch = JSON.parse(String(init?.body)) as Partial<DecisionRow>;
      for (const row of found) Object.assign(row, patch);
      return json(found.map((row) => ({ ...row })));
    }
  }
  throw new Error(`fake fetch: unexpected ${method} ${url.href}`);
}) as typeof fetch;

const receiptRoute = await import("../../app/api/execute/receipt/route");
const abortRoute = await import("../../app/api/execute/abort/route");

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

async function postReceipt(body: Record<string, unknown>) {
  const res = await receiptRoute.POST(
    new Request("http://localhost/api/execute/receipt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function postAbort(body: Record<string, unknown>) {
  const res = await abortRoute.POST(
    new Request("http://localhost/api/execute/abort", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const forged = {
  creditAcquired: 999,
  totalUsdgPaid: 0.01,
  quotePrice: 0.00001,
  executionPrice: 0.00001,
};

// D: unknown to the node -> pending, nothing written.
{
  const h = hashOf(0xd1);
  rows = [decisionRow("d1", { tx_hash: h, execution_status: "pending" })];
  const r = await postReceipt({ decisionId: "d1", txHash: h, walletAddress: WALLET });
  assert(r.status === 202 && r.body.status === "pending", "D: unseen tx stays pending");
  assert(row("d1").execution_status === "pending", "D: status unchanged");
}

// D: in mempool, no receipt yet -> pending.
{
  const h = hashOf(0xd2);
  chain.set(h, { tx: { ...rawTx1, hash: h, blockHash: null, blockNumber: null, transactionIndex: null }, receipt: null });
  rows = [decisionRow("d2", { tx_hash: h, execution_status: "pending" })];
  const r = await postReceipt({ decisionId: "d2", txHash: h, walletAddress: WALLET, ...forged });
  assert(r.status === 202 && r.body.status === "pending", "D: unmined tx stays pending");
  assert(row("d2").execution_status === "pending", "D: status pending");
  assert(row("d2").credit_acquired == null, "D: pending writes no CREDIT");
}

// A: another wallet's transaction.
{
  const h = hashOf(0xa1);
  chain.set(h, { tx: { ...rawTx1, hash: h, from: OTHER_WALLET }, receipt: rawReceipt(h, { from: OTHER_WALLET }) });
  rows = [decisionRow("a1", { tx_hash: h, execution_status: "pending" })];
  const r = await postReceipt({ decisionId: "a1", txHash: h, walletAddress: WALLET, ...forged });
  assert(r.status === 403, "A: wrong sender is 403");
  assert(row("a1").execution_status === "pending", "A: not confirmed");
}

// B: right calldata, wrong destination.
{
  const h = hashOf(0xb1);
  chain.set(h, { tx: { ...rawTx1, hash: h, to: USDG }, receipt: rawReceipt(h, { to: USDG }) });
  rows = [decisionRow("b1", { tx_hash: h, execution_status: "pending" })];
  const r = await postReceipt({ decisionId: "b1", txHash: h, walletAddress: WALLET, ...forged });
  assert(r.status === 409 && r.body.code === "destination", "B: wrong destination rejected");
  assert(row("b1").execution_status === "failed", "B: marked failed");
  assert(row("b1").credit_acquired == null, "B: no CREDIT recorded");
}

// C: reverted.
{
  const h = hashOf(0xc1);
  chain.set(h, { tx: { ...rawTx1, hash: h }, receipt: rawReceipt(h, { status: "0x0", logs: [] }) });
  rows = [decisionRow("c1", { tx_hash: h, execution_status: "pending" })];
  const r = await postReceipt({ decisionId: "c1", txHash: h, walletAddress: WALLET, ...forged });
  assert(r.status === 409, "C: reverted is 409");
  assert(row("c1").execution_status === "failed", "C: reverted becomes failed");
  assert(row("c1").credit_acquired == null && row("c1").total_usdg_paid == null, "C: no fill recorded");
}

// E: wrong selector to the exchange, successful receipt carrying real purchase logs.
{
  const h = hashOf(0xe1);
  const input = `0xdeadbeef${TX1_INPUT.slice(10)}`;
  chain.set(h, { tx: { ...rawTx1, hash: h, input }, receipt: rawReceipt(h) });
  rows = [decisionRow("e1", { tx_hash: h, execution_status: "pending" })];
  const r = await postReceipt({ decisionId: "e1", txHash: h, walletAddress: WALLET, ...forged });
  assert(r.status === 409 && r.body.code === "selector", "E: wrong selector rejected");
  assert(row("e1").execution_status === "failed", "E: not confirmed");
}

// F: successful plain buy() on the exchange.
{
  const h = hashOf(0xf1);
  chain.set(h, {
    tx: { ...rawTx1, hash: h, input: BUY_INPUT },
    receipt: rawReceipt(h, {
      logs: [
        boughtLog({ buyer: WALLET, recipient: WALLET, creditOut: 1_333_333n, usdgSpent: 1_000_000n }),
        usdgTransferLog(WALLET, EXCHANGE, 1_000_000n),
      ],
    }),
  });
  rows = [decisionRow("f1", { tx_hash: h, execution_status: "pending" })];
  const r = await postReceipt({ decisionId: "f1", txHash: h, walletAddress: WALLET, ...forged });
  assert(r.status === 409 && r.body.code === "selector", "F: other exchange function rejected");
  assert(row("f1").execution_status !== "success", "F: not confirmed");
}

// Budget above the validated quote is not confirmed.
{
  const h = hashOf(0x0b);
  chain.set(h, { tx: { ...rawTx1, hash: h }, receipt: rawReceipt(h) });
  rows = [decisionRow("q1", { tx_hash: h, execution_status: "pending", quoted_usdg: 0.5 })];
  const r = await postReceipt({ decisionId: "q1", txHash: h, walletAddress: WALLET });
  assert(r.status === 409 && r.body.code === "amount", "tx budget above validated quote rejected");
  assert(row("q1").execution_status === "pending", "mismatched budget not confirmed");
}

// G-M: real buyAndActivate with forged client figures.
chain.set(TX1, { tx: rawTx1, receipt: rawReceipt(TX1) });
{
  rows = [
    decisionRow("g1", { tx_hash: TX1, execution_status: "pending" }),
    decisionRow("n1", { execution_status: "awaiting_signature" }),
  ];
  const r = await postReceipt({ decisionId: "g1", txHash: TX1, walletAddress: WALLET, ...forged });
  assert(r.status === 200 && r.body.status === "success", "G: buyAndActivate accepted");
  const g = row("g1");
  assert(g.execution_status === "success", "G: confirmed");
  assert(g.credit_acquired === 1.333333, "H/K: CREDIT from chain, not client");
  assert(g.total_usdg_paid === 1, "I/L: USDG from chain, not client");
  assert(g.execution_price === 0.75, "J/M: price from verified values, not client");
  assert(g.tx_hash === TX1 && g.confirmed_at, "G: hash and confirmation time stored");

  const again = await postReceipt({ decisionId: "g1", txHash: TX1, walletAddress: WALLET, creditAcquired: 1, totalUsdgPaid: 1000 });
  assert(again.status === 200, "confirmed receipt replays");
  assert(row("g1").credit_acquired === 1.333333 && row("g1").total_usdg_paid === 1, "replay cannot rewrite amounts");

  // N: same tx hash on a second decision of the same wallet.
  const reuse = await postReceipt({ decisionId: "n1", txHash: TX1, walletAddress: WALLET });
  assert(reuse.status === 409 && reuse.body.code === "tx_reused", "N: hash reuse rejected");
  assert(row("n1").execution_status === "awaiting_signature" && row("n1").tx_hash == null, "N: second decision untouched");
  const reuseUpper = await postReceipt({ decisionId: "n1", txHash: TX1.toUpperCase().replace("0X", "0x"), walletAddress: WALLET });
  assert(reuseUpper.status === 409 && reuseUpper.body.code === "tx_reused", "N: hash reuse is case-insensitive");

  // O: abort cannot overwrite a confirmed purchase.
  const abort = await postAbort({ decisionId: "g1", walletAddress: WALLET, reason: "user closed" });
  assert(abort.status === 409 && abort.body.code === "confirmed", "O: abort on confirmed rejected");
  const after = row("g1");
  assert(after.execution_status === "success", "O: still confirmed");
  assert(after.credit_acquired === 1.333333 && after.total_usdg_paid === 1 && after.execution_price === 0.75, "O: amounts intact");
  assert(after.blocked_reason == null, "O: no failure reason written");

  // Abort still records a real pre-signature failure.
  const pre = await postAbort({ decisionId: "n1", walletAddress: WALLET, reason: "User rejected" });
  assert(pre.status === 200 && row("n1").execution_status === "failed", "abort still works before confirmation");
}

// Decision ownership is still enforced.
{
  rows = [decisionRow("w1", { tx_hash: TX1, execution_status: "pending", wallet_address: OTHER_WALLET })];
  const r = await postReceipt({ decisionId: "w1", txHash: TX1, walletAddress: WALLET });
  assert(r.status === 403, "decision owned by another wallet is forbidden");
  assert(row("w1").execution_status === "pending", "foreign decision untouched");
}

// A failed decision is terminal for the receipt route, even with its own recorded hash.
{
  rows = [decisionRow("p1", { tx_hash: TX1, execution_status: "pending" })];
  await postAbort({ decisionId: "p1", walletAddress: WALLET, reason: "closed tab" });
  assert(row("p1").execution_status === "failed", "abort before receipt writes failed");
  const snapshot = JSON.stringify(row("p1"));
  const r = await postReceipt({ decisionId: "p1", txHash: TX1, walletAddress: WALLET });
  assert(r.status === 409 && r.body.code === "not_receivable", "failed decision not confirmed by receipt");
  assert(JSON.stringify(row("p1")) === snapshot, "failed decision unchanged");
}

console.log("receipt route ok");
