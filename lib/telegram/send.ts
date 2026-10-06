/** One Telegram Bot API sendMessage call, classified for delivery bookkeeping. */

export const TELEGRAM_SEND_TIMEOUT_MS = 3_000;

export type TelegramSendResult =
  | { kind: "sent"; messageId: number | null }
  | { kind: "rate_limited"; retryAfterSeconds: number | null }
  | { kind: "server_error"; status: number }
  | { kind: "bot_unauthorized"; status: number }
  | { kind: "rejected"; status: number; description: string; chatUnusable: boolean }
  | { kind: "unknown"; reason: "timeout" | "network" };

export type TelegramMessage = {
  chatId: number;
  text: string;
  button: { text: string; url: string };
};

/** Errors that mean this chat can never receive the bot's messages. */
const CHAT_UNUSABLE_RE =
  /chat not found|user not found|bot was blocked|user is deactivated|bot was kicked|not enough rights to send|PEER_ID_INVALID|have no rights to send/i;

function cleanDescription(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\r\n]+/g, " ").slice(0, 200);
}

function isTimeout(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  return name === "AbortError" || name === "TimeoutError";
}

export function sendMessageBody(message: TelegramMessage) {
  return {
    chat_id: message.chatId,
    text: message.text,
    link_preview_options: { is_disabled: true },
    reply_markup: {
      inline_keyboard: [[{ text: message.button.text, url: message.button.url }]],
    },
  };
}

/**
 * Sends exactly one request. Never retries; the caller records the result.
 * Timeouts and network failures are `unknown` because Telegram may have
 * delivered the message even though the response was lost.
 */
export async function sendTelegramMessage(
  token: string,
  message: TelegramMessage,
  timeoutMs = TELEGRAM_SEND_TIMEOUT_MS,
): Promise<TelegramSendResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let status: number;
  let body: {
    ok?: unknown;
    description?: unknown;
    result?: { message_id?: unknown };
    parameters?: { retry_after?: unknown };
  } = {};
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sendMessageBody(message)),
      signal: controller.signal,
      cache: "no-store",
    });
    status = response.status;
    body = (await response.json().catch(() => ({}))) as typeof body;
  } catch (error) {
    return { kind: "unknown", reason: isTimeout(error) ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }

  if (status >= 200 && status < 300) {
    const id = body.result?.message_id;
    return {
      kind: "sent",
      messageId: typeof id === "number" && Number.isSafeInteger(id) ? id : null,
    };
  }
  if (status === 429) {
    const retryAfter = body.parameters?.retry_after;
    return {
      kind: "rate_limited",
      retryAfterSeconds:
        typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter >= 0
          ? retryAfter
          : null,
    };
  }
  if (status >= 500) return { kind: "server_error", status };
  if (status === 401 || status === 404) return { kind: "bot_unauthorized", status };
  const description = cleanDescription(body.description);
  return {
    kind: "rejected",
    status,
    description,
    chatUnusable: status === 403 || CHAT_UNUSABLE_RE.test(description),
  };
}
