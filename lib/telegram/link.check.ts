process.env.SUPABASE_URL = "http://supabase.test";
process.env.SUPABASE_SECRET_KEY = "test-secret";
process.env.ROBINHOOD_RPC_URL = "http://rpc.test";
process.env.ORBIO_MARKET_ORIGIN = "http://orbio.test";
process.env.NEXT_PUBLIC_APP_URL = "https://www.useora.site";
process.env.TELEGRAM_BOT_USERNAME = "OraAlertsBot";
process.env.TELEGRAM_WEBHOOK_SECRET = "test_webhook_secret_0123456789abcdef";
process.env.TELEGRAM_ALERTS_ENABLED = "false";
delete process.env.TELEGRAM_BOT_TOKEN;

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import type { TelegramLinkRequestRow, TelegramLinkRow } from "../db/telegram";

const linkRoute = await import("../../app/api/telegram/link/route");
const verifyRoute = await import("../../app/api/telegram/link/verify/route");
const disconnectRoute = await import("../../app/api/telegram/link/disconnect/route");
const webhookRoute = await import("../../app/api/telegram/webhook/route");
const { TelegramChatLinkedError, upsertWalletLink } = await import("../db/telegram");
const { LINK_CHALLENGE_TTL_MS, LINK_TOKEN_TTL_MS, hashLinkToken } = await import("./link");
const { TELEGRAM_REPLIES } = await import("./webhook");

function assert(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}

let passed = 0;
async function check(label: string, run: () => Promise<void> | void) {
  await run();
  passed += 1;
  console.log(`ok - ${label}`);
}

const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const ALICE = privateKeyToAccount(`0x${"11".repeat(32)}`);
const BOB = privateKeyToAccount(`0x${"22".repeat(32)}`);
const CAROL = privateKeyToAccount(`0x${"33".repeat(32)}`);
const walletOf = (account: { address: string }) => account.address.toLowerCase();

// ---------------------------------------------------------------------------
// Fake backend: PostgREST tables with the migration's constraints, plus an RPC
// that refuses every contract-signature check.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

let requests: TelegramLinkRequestRow[] = [];
let links: TelegramLinkRow[] = [];
const alertRows: Row[] = [
  { id: "alert-1", target_id: "target-1", wallet_address: walletOf(ALICE), status: "pending" },
  { id: "alert-2", target_id: "target-2", wallet_address: walletOf(BOB), status: "sent" },
];
const alertSnapshot = JSON.stringify(alertRows);
const outbound: string[] = [];
const methods: string[] = [];

const requestCount = () => requests.length;
const linkCount = () => links.length;
const linkFor = (wallet: string) => links.find((row) => row.wallet_address === wallet);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function matches(row: Row, column: string, expr: string): boolean {
  const value = row[column];
  if (expr === "is.null") return value == null;
  if (expr === "not.is.null") return value != null;
  const dot = expr.indexOf(".");
  const op = expr.slice(0, dot);
  const arg = expr.slice(dot + 1);
  if (op === "eq") return value != null && String(value) === arg;
  if (op === "gt") return value != null && Date.parse(String(value)) > Date.parse(arg);
  throw new Error(`fake postgrest: unsupported filter ${column}=${expr}`);
}

const CONTROL_PARAMS = new Set(["select", "order", "limit", "on_conflict", "columns"]);

function query<T extends Row>(rows: T[], url: URL): T[] {
  return rows.filter((row) =>
    [...url.searchParams].every(
      ([key, expr]) => CONTROL_PARAMS.has(key) || matches(row, key, expr),
    ),
  );
}

function respondRows(rows: Row[], init: RequestInit | undefined, status = 200) {
  const accept = new Headers(init?.headers).get("accept") ?? "";
  if (!accept.includes("vnd.pgrst.object+json")) return json(rows, status);
  if (rows.length !== 1) {
    return json(
      {
        code: "PGRST116",
        message: "JSON object requested, multiple (or no) rows returned",
        details: `The result contains ${rows.length} rows`,
      },
      406,
    );
  }
  return json(rows[0], status);
}

function uniqueViolation(message: string) {
  return json({ code: "23505", message, details: null, hint: null }, 409);
}

/** Mirrors telegram_link_requests constraints from the migration. */
function requestViolation(row: TelegramLinkRequestRow): string | null {
  if (!/^[0-9a-f]{32}$/.test(row.nonce)) return "nonce_check";
  if (row.token_hash != null && !/^[0-9a-f]{64}$/.test(row.token_hash)) return "token_hash_check";
  if ((row.token_hash == null) !== (row.token_expires_at == null)) return "token_pair_check";
  if (row.token_hash != null && (row.verified_at == null || row.purpose !== "link")) {
    return "token_verified_check";
  }
  const consumedOk =
    (row.consumed_at == null && row.telegram_chat_id == null) ||
    (row.consumed_at != null && row.token_hash != null && row.telegram_chat_id != null);
  return consumedOk ? null : "consumed_check";
}

function activeChatConflict(row: TelegramLinkRow): boolean {
  return links.some(
    (other) =>
      other.wallet_address !== row.wallet_address &&
      other.disabled_at == null &&
      row.disabled_at == null &&
      other.telegram_chat_id === row.telegram_chat_id,
  );
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
  );
  const method = (init?.method ?? "GET").toUpperCase();
  methods.push(`${method} ${url.pathname}`);

  if (url.host !== "supabase.test" && url.host !== "rpc.test") {
    outbound.push(url.href);
    throw new Error(`unexpected outbound request to ${url.host}`);
  }

  if (url.host === "rpc.test") {
    const parsed = JSON.parse(String(init?.body));
    const handle = (req: { id: number }) => ({
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32000, message: "execution reverted" },
    });
    return json(Array.isArray(parsed) ? parsed.map(handle) : handle(parsed));
  }

  if (url.pathname === "/rest/v1/telegram_link_requests") {
    if (method === "GET") return respondRows(query(requests, url), init);
    if (method === "POST") {
      const body = JSON.parse(String(init?.body)) as Partial<TelegramLinkRequestRow>;
      const row: TelegramLinkRequestRow = {
        id: String(body.id),
        wallet_address: String(body.wallet_address),
        purpose: body.purpose ?? "link",
        nonce: String(body.nonce),
        wallet_message: String(body.wallet_message),
        expires_at: String(body.expires_at),
        verified_at: body.verified_at ?? null,
        token_hash: body.token_hash ?? null,
        token_expires_at: body.token_expires_at ?? null,
        consumed_at: body.consumed_at ?? null,
        telegram_chat_id: body.telegram_chat_id ?? null,
        created_at: new Date().toISOString(),
      };
      if (requests.some((other) => other.nonce === row.nonce || other.id === row.id)) {
        return uniqueViolation("duplicate key value violates telegram_link_requests_nonce_key");
      }
      const violation = requestViolation(row);
      if (violation) return json({ code: "23514", message: violation }, 400);
      requests.push(row);
      return respondRows([row], init, 201);
    }
    if (method === "PATCH") {
      const found = query(requests, url);
      const patch = JSON.parse(String(init?.body)) as Partial<TelegramLinkRequestRow>;
      for (const row of found) {
        const next = { ...row, ...patch };
        const violation = requestViolation(next);
        if (violation) return json({ code: "23514", message: violation }, 400);
        if (
          next.token_hash != null &&
          requests.some((other) => other !== row && other.token_hash === next.token_hash)
        ) {
          return uniqueViolation("duplicate key value violates telegram_link_requests_token_hash_key");
        }
      }
      for (const row of found) Object.assign(row, patch);
      return respondRows(found, init);
    }
  }

  if (url.pathname === "/rest/v1/telegram_links") {
    if (method === "GET") return respondRows(query(links, url), init);
    if (method === "POST") {
      assert(url.searchParams.get("on_conflict") === "wallet_address", "link upsert keys on wallet");
      const body = JSON.parse(String(init?.body)) as TelegramLinkRow;
      const existing = linkFor(body.wallet_address);
      const next: TelegramLinkRow = {
        ...(existing ?? { created_at: new Date().toISOString() }),
        ...body,
      } as TelegramLinkRow;
      if ((next.disabled_at == null) !== (next.disabled_reason == null)) {
        return json({ code: "23514", message: "telegram_links_disabled_check" }, 400);
      }
      if (activeChatConflict(next)) {
        return uniqueViolation("duplicate key value violates telegram_links_active_chat_key");
      }
      if (existing) Object.assign(existing, next);
      else links.push(next);
      return respondRows([existing ?? next], init, 201);
    }
    if (method === "PATCH") {
      const found = query(links, url);
      const patch = JSON.parse(String(init?.body)) as Partial<TelegramLinkRow>;
      for (const row of found) Object.assign(row, patch);
      return respondRows(found, init);
    }
  }

  if (url.pathname === "/rest/v1/target_alerts") {
    if (method === "GET") return respondRows(query(alertRows, url), init);
    throw new Error(`telegram code must not ${method} target_alerts`);
  }

  throw new Error(`fake backend: unexpected ${method} ${url.pathname}`);
}) as typeof fetch;

// ---------------------------------------------------------------------------
// Helpers that drive the real route handlers.
// ---------------------------------------------------------------------------

type Account = typeof ALICE;
type Challenge = { challengeId: string; message: string; expiresAt: string };

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`https://www.useora.site${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function challenge(account: Account, purpose: "link" | "unlink" = "link") {
  const response = await linkRoute.POST(
    post("/api/telegram/link", { walletAddress: account.address, purpose }),
  );
  assert(response.status === 201, `challenge created (${response.status})`);
  return (await response.json()) as Challenge;
}

async function verify(input: { challengeId: string; wallet: string; signature: string }) {
  const response = await verifyRoute.POST(
    post("/api/telegram/link/verify", {
      challengeId: input.challengeId,
      walletAddress: input.wallet,
      signature: input.signature,
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** Full browser flow: challenge, sign, verify. Returns the plaintext token from the deep link. */
async function issueToken(account: Account): Promise<string> {
  const c = await challenge(account);
  const signature = await account.signMessage({ message: c.message });
  const result = await verify({ challengeId: c.challengeId, wallet: account.address, signature });
  assert(result.status === 200, `verify succeeds (${result.status})`);
  const deepLink = String(result.body.deepLink);
  const token = new URL(deepLink).searchParams.get("start");
  assert(token, "deep link carries a start token");
  return token;
}

type ChatType = "private" | "group" | "supergroup" | "channel";

function message(text: string, chatId: number, type: ChatType = "private", fromId = chatId) {
  return {
    update_id: Math.floor(Math.random() * 1e9),
    message: {
      message_id: 1,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type },
      from: { id: fromId, is_bot: false, first_name: "Test" },
      text,
    },
  };
}

async function webhook(update: unknown, headers: Record<string, string> | null = {
  "X-Telegram-Bot-Api-Secret-Token": SECRET!,
}) {
  const response = await webhookRoute.POST(post("/api/telegram/webhook", update, headers ?? {}));
  const raw = await response.text();
  return { status: response.status, raw, body: JSON.parse(raw) as Record<string, unknown> };
}

async function status(account: Account) {
  const response = await linkRoute.GET(
    new Request(`https://www.useora.site/api/telegram/link?wallet=${account.address}`),
  );
  return (await response.json()) as Record<string, unknown>;
}

function reset() {
  requests = [];
  links = [];
}

const CHAT_A = 1001;
const CHAT_B = 1002;
const CHAT_C = 1003;

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

await check("1. challenge creation stores the exact signed message", async () => {
  reset();
  const before = Date.now();
  const c = await challenge(ALICE);
  const row = requests[0];
  assert(requestCount() === 1 && row.id === c.challengeId, "one challenge row");
  assert(row.wallet_message === c.message, "stored message is the returned message");
  assert(row.wallet_address === walletOf(ALICE), "wallet normalized");
  assert(/^[0-9a-f]{32}$/.test(row.nonce), "nonce is 128-bit hex");
  assert(row.verified_at == null && row.token_hash == null, "nothing verified yet");
  const issuedAt = Date.parse(/Issued At: (\S+)/.exec(c.message)?.[1] ?? "");
  assert(issuedAt >= before && issuedAt <= Date.now(), "issued during the request");
  assert(Date.parse(row.expires_at) - issuedAt === LINK_CHALLENGE_TTL_MS, "10 min expiry");
  for (const needle of [
    "Link Telegram alerts to Ora",
    `Wallet: ${walletOf(ALICE)}`,
    "authorizes NO transaction",
    "authorizes NO spending",
    "authorizes NO CREDIT purchase",
    `Nonce: ${row.nonce}`,
    "Issued At: ",
    `Expiration Time: ${row.expires_at}`,
    "https://www.useora.site",
    "www.useora.site asks you to sign",
  ]) {
    assert(c.message.includes(needle), `message contains "${needle}"`);
  }
  const second = await challenge(ALICE);
  assert(requests[1].nonce !== row.nonce && second.challengeId !== c.challengeId, "fresh nonce per challenge");

  const missing = await linkRoute.POST(post("/api/telegram/link", { walletAddress: "nope" }));
  assert(missing.status === 400, "invalid wallet rejected");

  delete process.env.TELEGRAM_BOT_USERNAME;
  const unavailable = await linkRoute.POST(post("/api/telegram/link", { walletAddress: ALICE.address }));
  assert(unavailable.status === 503, "linking unavailable without bot configuration");
  process.env.TELEGRAM_BOT_USERNAME = "OraAlertsBot";

  const s = await status(ALICE);
  assert(JSON.stringify(Object.keys(s).sort()) === '["available","connected"]', "status exposes only connected/available");
  assert(s.connected === false && s.available === true, "status before linking");
});

await check("2. expired challenge is rejected", async () => {
  reset();
  const c = await challenge(ALICE);
  const signature = await ALICE.signMessage({ message: c.message });
  requests[0].expires_at = new Date(Date.now() - 1_000).toISOString();
  const result = await verify({ challengeId: c.challengeId, wallet: ALICE.address, signature });
  assert(result.status === 400, "expired challenge rejected");
  assert(requests[0].verified_at == null && requests[0].token_hash == null, "no token issued");
});

await check("3. challenge cannot be reused", async () => {
  reset();
  const c = await challenge(ALICE);
  const signature = await ALICE.signMessage({ message: c.message });
  const first = await verify({ challengeId: c.challengeId, wallet: ALICE.address, signature });
  const hash = requests[0].token_hash;
  const second = await verify({ challengeId: c.challengeId, wallet: ALICE.address, signature });
  assert(first.status === 200 && second.status === 400, "second verify rejected");
  assert(second.body.error === first.body.error || second.body.deepLink === undefined, "no second link");
  assert(requests[0].token_hash === hash, "token hash unchanged by reuse");
});

await check("4. wallet mismatch is rejected", async () => {
  reset();
  const c = await challenge(ALICE);
  const bobSignature = await BOB.signMessage({ message: c.message });
  const asBob = await verify({ challengeId: c.challengeId, wallet: BOB.address, signature: bobSignature });
  assert(asBob.status === 400, "other wallet cannot claim the challenge");
  const aliceSignature = await ALICE.signMessage({ message: c.message });
  const claimedByBob = await verify({ challengeId: c.challengeId, wallet: BOB.address, signature: aliceSignature });
  assert(claimedByBob.status === 400, "claiming another wallet's signature fails");
  assert(requests[0].verified_at == null, "challenge still unverified");
});

await check("5. invalid signature is rejected", async () => {
  reset();
  const c = await challenge(ALICE);
  const wrongMessage = await ALICE.signMessage({ message: `${c.message}\nextra` });
  const bobSigned = await BOB.signMessage({ message: c.message });
  for (const signature of [wrongMessage, bobSigned, "0x1234", "not-hex", ""]) {
    const result = await verify({ challengeId: c.challengeId, wallet: ALICE.address, signature });
    assert(result.status === 400, `invalid signature rejected (${signature.slice(0, 10)})`);
  }
  const unknown = await verify({
    challengeId: "00000000-0000-4000-8000-000000000000",
    wallet: ALICE.address,
    signature: wrongMessage,
  });
  const expiredMsg = await verify({ challengeId: c.challengeId, wallet: ALICE.address, signature: bobSigned });
  assert(unknown.body.error === expiredMsg.body.error, "generic error does not reveal challenge existence");
  assert(requests[0].verified_at == null && requests[0].token_hash == null, "no token issued");
});

let aliceToken = "";

await check("6. valid signature returns a one-time deep link and creates no link yet", async () => {
  reset();
  const c = await challenge(ALICE);
  const signature = await ALICE.signMessage({ message: c.message });
  const result = await verify({ challengeId: c.challengeId, wallet: ALICE.address, signature });
  assert(result.status === 200, "verified");
  const deepLink = String(result.body.deepLink);
  assert(/^https:\/\/t\.me\/OraAlertsBot\?start=[A-Za-z0-9_-]{43}$/.test(deepLink), `deep link format ${deepLink}`);
  assert(requests[0].verified_at != null, "challenge marked verified");
  assert(linkCount() === 0, "no telegram link before /start");
  assert((await status(ALICE)).connected === false, "status still disconnected");
  aliceToken = new URL(deepLink).searchParams.get("start")!;
});

await check("7. plaintext token is never stored", async () => {
  const stored = JSON.stringify({ requests, links });
  assert(!stored.includes(aliceToken), "token absent from storage");
  const expected = createHash("sha256").update(aliceToken).digest("hex");
  assert(requests[0].token_hash === expected && hashLinkToken(aliceToken) === expected, "only SHA-256 stored");
  const source = readFileSync(join("lib", "db", "telegram.ts"), "utf8");
  assert(!/token:\s/.test(source), "db layer has no plaintext token column");
});

await check("8. token expires 10 minutes after verification", async () => {
  const row = requests[0];
  const ttl = Date.parse(row.token_expires_at!) - Date.parse(row.verified_at!);
  assert(ttl === LINK_TOKEN_TTL_MS, `token ttl is 10 minutes (${ttl})`);
});

await check("10. valid /start in a private chat creates the link", async () => {
  const result = await webhook(message(`/start ${aliceToken}`, CHAT_A));
  assert(result.status === 200 && result.body.result === "linked", `linked (${result.raw})`);
  assert(result.body.reply === TELEGRAM_REPLIES.linked, "success text");
  assert(result.body.reply === "Telegram alerts are now connected to Ora.", "exact success text");
  const link = linkFor(walletOf(ALICE));
  assert(link && link.telegram_chat_id === CHAT_A && link.telegram_user_id === CHAT_A, "link row");
  assert(link.disabled_at == null && link.disabled_reason == null, "active");
  assert(requests[0].consumed_at != null && requests[0].telegram_chat_id === CHAT_A, "request consumed");
  assert((await status(ALICE)).connected === true, "status connected");
  for (const secret of [walletOf(ALICE), aliceToken, requests[0].id, requests[0].token_hash!]) {
    assert(!result.raw.toLowerCase().includes(secret.toLowerCase()), "response leaks no identifiers");
  }
});

await check("9. token is one-time", async () => {
  const again = await webhook(message(`/start ${aliceToken}`, CHAT_A));
  const elsewhere = await webhook(message(`/start ${aliceToken}`, CHAT_B));
  assert(again.body.result === "invalid_link" && elsewhere.body.result === "invalid_link", "consumed token rejected");
  assert(linkCount() === 1 && linkFor(walletOf(ALICE))!.telegram_chat_id === CHAT_A, "link unchanged");
});

await check("11. invalid token creates no link", async () => {
  reset();
  for (const text of [
    `/start ${randomBytes(32).toString("base64url")}`,
    "/start short",
    "/start ../../etc",
    "/start",
  ]) {
    const result = await webhook(message(text, CHAT_A));
    assert(result.status === 200, "handled");
    assert(["invalid_link", "start_help"].includes(String(result.body.result)), `rejected: ${text}`);
  }
  assert(linkCount() === 0, "no link");
  const unknown = await webhook(message(`/start ${randomBytes(32).toString("base64url")}`, CHAT_A));
  const malformed = await webhook(message("/start short", CHAT_A));
  assert(unknown.body.reply === malformed.body.reply, "generic invalid-token reply");
});

await check("12. expired token creates no link", async () => {
  reset();
  const token = await issueToken(ALICE);
  requests[0].token_expires_at = new Date(Date.now() - 1_000).toISOString();
  const result = await webhook(message(`/start ${token}`, CHAT_A));
  assert(result.body.result === "invalid_link", "expired token rejected");
  assert(linkCount() === 0 && requests[0].consumed_at == null, "nothing consumed or linked");
});

await check("13. missing webhook secret is rejected", async () => {
  reset();
  const token = await issueToken(ALICE);
  const noHeader = await webhook(message(`/start ${token}`, CHAT_A), null);
  assert(noHeader.status === 401, "no header rejected");
  const saved = process.env.TELEGRAM_WEBHOOK_SECRET;
  delete process.env.TELEGRAM_WEBHOOK_SECRET;
  const unconfigured = await webhook(message(`/start ${token}`, CHAT_A));
  const emptyHeader = await webhook(message(`/start ${token}`, CHAT_A), {
    "X-Telegram-Bot-Api-Secret-Token": "",
  });
  process.env.TELEGRAM_WEBHOOK_SECRET = saved;
  assert(unconfigured.status === 401 && emptyHeader.status === 401, "unset server secret rejects all");
  assert(linkCount() === 0 && requests[0].consumed_at == null, "token untouched");
});

await check("14. wrong webhook secret is rejected", async () => {
  const token = await issueToken(BOB);
  for (const value of ["wrong", `${SECRET}x`, SECRET!.slice(0, -1), `Bearer ${SECRET}`]) {
    const result = await webhook(message(`/start ${token}`, CHAT_B), {
      "X-Telegram-Bot-Api-Secret-Token": value,
    });
    assert(result.status === 401, `wrong secret rejected (${value.slice(0, 8)})`);
  }
  assert(linkCount() === 0, "no link");
});

await check("15. group and supergroup messages are ignored", async () => {
  reset();
  const token = await issueToken(ALICE);
  for (const type of ["group", "supergroup"] as const) {
    const result = await webhook(message(`/start ${token}`, -100123, type, CHAT_A));
    assert(result.status === 200 && result.body.result === "ignored", `${type} ignored`);
    const stop = await webhook(message("/stop", -100123, type, CHAT_A));
    assert(stop.body.result === "ignored", `${type} /stop ignored`);
  }
  const notFromChat = await webhook(message(`/start ${token}`, CHAT_A, "private", CHAT_B));
  assert(notFromChat.body.result === "ignored", "sender must be the private chat");
  const fromBot = message(`/start ${token}`, CHAT_A);
  fromBot.message.from.is_bot = true;
  assert((await webhook(fromBot)).body.result === "ignored", "bots ignored");
  for (const update of [{ update_id: 1 }, { update_id: 2, edited_message: message(`/start ${token}`, CHAT_A).message }, "not json {"]) {
    assert((await webhook(update)).body.result === "ignored", "unrelated update ignored");
  }
  assert(requests[0].consumed_at == null && linkCount() === 0, "token still unused");
  const ok = await webhook(message(`/start ${token}`, CHAT_A));
  assert(ok.body.result === "linked", "token still works in the private chat");
});

await check("16. channel messages are ignored", async () => {
  reset();
  const token = await issueToken(ALICE);
  const post = {
    update_id: 3,
    channel_post: { message_id: 1, chat: { id: -1009, type: "channel" }, text: `/start ${token}` },
  };
  assert((await webhook(post)).body.result === "ignored", "channel_post ignored");
  assert((await webhook(message(`/start ${token}`, -1009, "channel"))).body.result === "ignored", "channel chat ignored");
  assert(requests[0].consumed_at == null && linkCount() === 0, "token still unused");
});

await check("17. Telegram cannot supply a wallet", async () => {
  reset();
  const asWallet = await webhook(message(`/start ${walletOf(BOB)}`, CHAT_A));
  assert(asWallet.body.result === "invalid_link", "wallet as start parameter rejected");
  const token = await issueToken(ALICE);
  const extra = await webhook(message(`/start ${token} ${walletOf(BOB)}`, CHAT_A));
  assert(extra.body.result === "ignored", "extra wallet argument not parsed");
  const injected = message(`/start ${token}`, CHAT_A) as ReturnType<typeof message> & Row;
  Object.assign(injected, { wallet: walletOf(BOB), walletAddress: walletOf(BOB) });
  Object.assign(injected.message, { wallet: walletOf(BOB), walletAddress: walletOf(BOB) });
  const result = await webhook(injected);
  assert(result.body.result === "linked", "linked");
  assert(linkFor(walletOf(ALICE)) && !linkFor(walletOf(BOB)), "link uses the signed wallet only");
  const source = readFileSync(join("lib", "telegram", "webhook.ts"), "utf8");
  assert(!/normalizeWalletAddress|walletFrom|wallet_address\s*:/.test(source), "webhook never reads a wallet from the update");
});

await check("18. existing link cannot be silently reassigned", async () => {
  reset();
  await webhook(message(`/start ${await issueToken(ALICE)}`, CHAT_A));
  const bobToken = await issueToken(BOB);
  const result = await webhook(message(`/start ${bobToken}`, CHAT_A));
  assert(result.body.result === "chat_linked_elsewhere", "chat already linked to another wallet");
  assert(result.body.reply === TELEGRAM_REPLIES.chatLinkedElsewhere, "explains /stop");
  assert(linkFor(walletOf(ALICE))!.telegram_chat_id === CHAT_A && linkFor(walletOf(ALICE))!.disabled_at == null, "alice untouched");
  assert(!linkFor(walletOf(BOB)), "bob not linked");

  let raced = false;
  try {
    await upsertWalletLink({ walletAddress: walletOf(BOB), telegramUserId: CHAT_A, telegramChatId: CHAT_A, now: new Date() });
  } catch (error) {
    raced = error instanceof TelegramChatLinkedError;
  }
  assert(raced, "database unique index blocks a racing reassignment");

  const same = await webhook(message(`/start ${await issueToken(ALICE)}`, CHAT_A));
  assert(same.body.result === "already_linked" && linkCount() === 1, "same wallet and chat is idempotent");

  const moved = await webhook(message(`/start ${await issueToken(ALICE)}`, CHAT_B));
  assert(moved.body.result === "linked", "newly signed link for the same wallet");
  const alice = linkFor(walletOf(ALICE))!;
  assert(alice.telegram_chat_id === CHAT_B && linkCount() === 1, "wallet keeps one link row, now chat B");
  const bobNow = await webhook(message(`/start ${await issueToken(BOB)}`, CHAT_A));
  assert(bobNow.body.result === "linked", "freed chat can link another wallet");
});

await check("19. /stop affects only the requesting chat", async () => {
  reset();
  await webhook(message(`/start ${await issueToken(ALICE)}`, CHAT_A));
  await webhook(message(`/start ${await issueToken(BOB)}`, CHAT_B));
  const stopped = await webhook(message("/stop", CHAT_A));
  assert(stopped.body.result === "stopped", "stopped");
  assert(stopped.body.reply === "Telegram alerts have been disconnected from Ora.", "exact stop text");
  const alice = linkFor(walletOf(ALICE))!;
  const bob = linkFor(walletOf(BOB))!;
  assert(alice.disabled_at != null && alice.disabled_reason === "user_requested", "alice disabled");
  assert(bob.disabled_at == null && bob.telegram_chat_id === CHAT_B, "bob untouched");
  const none = await webhook(message("/stop", CHAT_C));
  assert(none.body.result === "not_linked" && none.body.reply === TELEGRAM_REPLIES.notLinked, "generic reply");
  const again = await webhook(message("/stop@OraAlertsBot", CHAT_A));
  assert(again.body.result === "not_linked", "second /stop is a no-op");
  assert((await status(ALICE)).connected === false && (await status(BOB)).connected === true, "status per wallet");
});

await check("20. /stop and Disconnect preserve alert records", async () => {
  assert(JSON.stringify(alertRows) === alertSnapshot, "alerts unchanged after /stop");
  const c = await challenge(BOB, "unlink");
  assert(c.message.includes("Disconnect Telegram alerts from Ora"), "unlink message");
  const forged = await disconnectRoute.POST(
    post("/api/telegram/link/disconnect", {
      challengeId: c.challengeId,
      walletAddress: BOB.address,
      signature: await CAROL.signMessage({ message: c.message }),
    }),
  );
  assert(forged.status === 400 && linkFor(walletOf(BOB))!.disabled_at == null, "unsigned disconnect rejected");
  const linkChallenge = await challenge(BOB, "link");
  const wrongPurpose = await disconnectRoute.POST(
    post("/api/telegram/link/disconnect", {
      challengeId: linkChallenge.challengeId,
      walletAddress: BOB.address,
      signature: await BOB.signMessage({ message: linkChallenge.message }),
    }),
  );
  assert(wrongPurpose.status === 400, "link challenge cannot disconnect");
  const ok = await disconnectRoute.POST(
    post("/api/telegram/link/disconnect", {
      challengeId: c.challengeId,
      walletAddress: BOB.address,
      signature: await BOB.signMessage({ message: c.message }),
    }),
  );
  assert(ok.status === 200, "signed disconnect");
  const bob = linkFor(walletOf(BOB))!;
  assert(bob.disabled_at != null && bob.disabled_reason === "wallet_requested", "bob disabled by wallet");
  const unlinkRow = requests.find((row) => row.id === c.challengeId)!;
  assert(unlinkRow.token_hash == null && unlinkRow.verified_at != null, "unlink challenge issues no token");
  assert(JSON.stringify(alertRows) === alertSnapshot, "alerts unchanged after Disconnect");
  assert(!methods.some((entry) => entry.startsWith("DELETE")), "nothing is ever deleted");
  assert(!methods.some((entry) => entry.includes("target_alerts")), "telegram code never touches target_alerts");
  assert(linkCount() === 2, "disabled link rows retained");
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : [path];
  });
}

await check("21. linking never sends; Bot API calls are confined to the alert sender", async () => {
  const sender = join("lib", "telegram", "send.ts");
  const delivery = new Set([
    sender,
    join("lib", "telegram", "delivery-config.ts"),
    join("lib", "telegram", "notify.ts"),
  ]);
  const files = [
    ...sourceFiles(join("lib", "telegram")).filter(
      (path) => !path.endsWith(".check.ts") && !delivery.has(path),
    ),
    ...sourceFiles(join("app", "api", "telegram")),
    join("lib", "db", "telegram.ts"),
    join("components", "TelegramAlerts.tsx"),
    join("src", "telegram-webhook.ts"),
  ];
  for (const path of files) {
    const source = readFileSync(path, "utf8");
    assert(!/sendMessage/.test(source), `${path} has no sendMessage`);
    assert(!/getUpdates/.test(source), `${path} does not poll`);
    if (!path.endsWith("telegram-webhook.ts")) {
      assert(!/api\.telegram\.org|TELEGRAM_BOT_TOKEN/.test(source), `${path} never calls the Bot API`);
    }
  }
  const senderSource = readFileSync(sender, "utf8");
  assert((senderSource.match(/api\.telegram\.org/g) ?? []).length === 1, "sender has one Bot API call");
  assert(!/TELEGRAM_BOT_TOKEN/.test(senderSource), "sender receives the token, it does not read env");
  const webhookResponse = await webhook(message("/stop", CHAT_C));
  assert(!("method" in webhookResponse.body), "webhook reply is not a Bot API method call");
  assert(outbound.length === 0, "no request ever left for Telegram");
  const client = readFileSync(join("components", "TelegramAlerts.tsx"), "utf8");
  assert(!/TELEGRAM_|createLinkToken|randomBytes/.test(client), "browser never sees secrets or builds tokens");
});

await check("22. Stage 1 and procurement files are unchanged", () => {
  const protectedPaths = [
    "lib/ora/alerts",
    "lib/db/alerts.ts",
    "lib/db/targets.ts",
    "lib/ora/watch-targets.ts",
    "lib/ora/decision.ts",
    "lib/ora/target.ts",
    "lib/ora/quote-rule.ts",
    "lib/orbio",
    "app/api/targets",
    "app/api/execute",
    "app/api/quote",
    "app/api/decision",
    "supabase/migrations/20261005120000_target_ready_alerts.sql",
    "vercel.json",
  ];
  const diff = execFileSync("git", ["diff", "--name-only", "HEAD", "--", ...protectedPaths], {
    encoding: "utf8",
  }).trim();
  assert(diff === "", `protected files changed:\n${diff}`);
  const untracked = execFileSync(
    "git",
    ["ls-files", "--others", "--exclude-standard", "--", ...protectedPaths],
    { encoding: "utf8" },
  ).trim();
  assert(untracked === "", `new files in protected paths:\n${untracked}`);

  const observe = readFileSync(join("app", "api", "observe", "route.ts"), "utf8");
  const evaluation = observe.indexOf("evaluateOpenTargetsAfterObservation(result.book)");
  const notify = observe.indexOf("deliverTelegramNotifications(");
  assert(evaluation > 0 && notify > evaluation, "observe evaluates targets before Telegram notifications");
  assert(/try \{\s*const \{ deliverTelegramNotifications \}/.test(observe), "notifications isolated in try/catch");
  assert(observe.includes("export const maxDuration = 30;"), "observe maxDuration unchanged");
});

console.log(`\n${passed} telegram link checks passed`);
