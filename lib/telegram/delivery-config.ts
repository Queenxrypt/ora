/** Server-only delivery settings. Read per call so builds never need them. */

const BOT_TOKEN_RE = /^\d{5,16}:[A-Za-z0-9_-]{30,64}$/;

/** Delivery runs only when explicitly enabled; any other value keeps it off. */
export function telegramAlertsEnabled(): boolean {
  return process.env.TELEGRAM_ALERTS_ENABLED?.trim().toLowerCase() === "true";
}

export function telegramBotToken(): string | null {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  return token && BOT_TOKEN_RE.test(token) ? token : null;
}
