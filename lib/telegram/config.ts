/** Server-only Telegram settings. Read per request so builds never need them. */

const BOT_USERNAME_RE = /^[A-Za-z][A-Za-z0-9_]{1,28}bot$/i;

export function telegramBotUsername(): string | null {
  const raw = process.env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, "");
  return raw && BOT_USERNAME_RE.test(raw) ? raw : null;
}

export function telegramWebhookSecret(): string | null {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
  return secret ? secret : null;
}

/** Linking needs the bot for the deep link and the secret to trust its webhook. */
export function telegramLinkingAvailable(): boolean {
  return telegramBotUsername() != null && telegramWebhookSecret() != null;
}

/** Canonical Ora origin, shown in the wallet message. */
export function oraAppUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL?.trim() || "https://www.useora.site").replace(
    /\/+$/,
    "",
  );
}
