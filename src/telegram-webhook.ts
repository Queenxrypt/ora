/**
 * Manual Telegram webhook helper. Never runs on startup.
 *
 *   npm run telegram:webhook          read-only: prints getWebhookInfo
 *   npm run telegram:webhook -- set   registers <NEXT_PUBLIC_APP_URL>/api/telegram/webhook
 *
 * Reads TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET from .env.local. Neither is printed.
 */
import { config } from "dotenv";

config({ path: ".env.local" });

const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
if (!token) {
  throw new Error("Missing TELEGRAM_BOT_TOKEN. Add it to .env.local before running this helper.");
}

const appUrl = (process.env.NEXT_PUBLIC_APP_URL?.trim() || "https://www.useora.site").replace(
  /\/+$/,
  "",
);
const webhookUrl = `${appUrl}/api/telegram/webhook`;

async function callTelegram(method: string, body?: Record<string, unknown>) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const json = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    description?: string;
    result?: unknown;
  };
  if (!response.ok || json.ok !== true) {
    throw new Error(`Telegram ${method} failed: ${json.description ?? response.status}`);
  }
  return json.result;
}

async function printWebhookInfo() {
  const info = (await callTelegram("getWebhookInfo")) as {
    url?: string;
    pending_update_count?: number;
    last_error_date?: number;
    last_error_message?: string;
    allowed_updates?: string[];
  };
  console.log({
    url: info.url || "(none)",
    pendingUpdates: info.pending_update_count ?? 0,
    allowedUpdates: info.allowed_updates ?? "(default)",
    lastError: info.last_error_message
      ? `${info.last_error_message} at ${new Date((info.last_error_date ?? 0) * 1000).toISOString()}`
      : null,
  });
}

async function main() {
  const action = process.argv[2];
  if (action === undefined || action === "info") {
    await printWebhookInfo();
    return;
  }
  if (action !== "set") {
    throw new Error(`Unknown action "${action}". Use "info" (default) or "set".`);
  }
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (!secret || !/^[A-Za-z0-9_-]{32,256}$/.test(secret)) {
    throw new Error(
      "TELEGRAM_WEBHOOK_SECRET must be 32-256 characters of A-Z, a-z, 0-9, _ or -.",
    );
  }
  if (!webhookUrl.startsWith("https://")) {
    throw new Error(`Telegram webhooks require HTTPS; got ${webhookUrl}.`);
  }
  await callTelegram("setWebhook", {
    url: webhookUrl,
    secret_token: secret,
    allowed_updates: ["message"],
    drop_pending_updates: true,
  });
  console.log(`Webhook set to ${webhookUrl}`);
  await printWebhookInfo();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
