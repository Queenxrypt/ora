import {
  consumeLinkToken,
  disableLinkForChat,
  readActiveLinkForChat,
  TelegramChatLinkedError,
  upsertWalletLink,
} from "../db/telegram";
import { hashLinkToken, isLinkTokenFormat } from "./link";

/** Never contain a wallet, target, decision, token or internal id. */
export const TELEGRAM_REPLIES = {
  linked: "Telegram alerts are now connected to Ora.",
  alreadyLinked: "Telegram alerts are already connected to Ora.",
  chatLinkedElsewhere:
    "This Telegram account is already connected to a different Ora wallet. Send /stop to disconnect it first.",
  invalidLink: "This link is invalid or has expired. Open Ora and choose Connect Telegram again.",
  start: "Open Ora and choose Connect Telegram to receive procurement alerts.",
  stopped: "Telegram alerts have been disconnected from Ora.",
  notLinked: "No Ora alerts are connected to this Telegram account.",
} as const;

export type TelegramCommand =
  | { kind: "start"; chatId: number; userId: number; token: string | null }
  | { kind: "stop"; chatId: number }
  | { kind: "ignored" };

export type TelegramUpdateResult =
  | "linked"
  | "already_linked"
  | "chat_linked_elsewhere"
  | "invalid_link"
  | "start_help"
  | "stopped"
  | "not_linked"
  | "ignored";

const START_RE = /^\/start(?:@[A-Za-z0-9_]+)?(?:\s+(\S+))?\s*$/;
const STOP_RE = /^\/stop(?:@[A-Za-z0-9_]+)?\s*$/;

function asSafeId(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

/**
 * Accepts only text messages a person sends to the bot in a private chat.
 * Groups, supergroups, channels, bots and every other update are ignored.
 */
export function parseTelegramCommand(update: unknown): TelegramCommand {
  if (!update || typeof update !== "object") return { kind: "ignored" };
  const message = (update as { message?: unknown }).message;
  if (!message || typeof message !== "object") return { kind: "ignored" };
  const { chat, from, text } = message as {
    chat?: { id?: unknown; type?: unknown };
    from?: { id?: unknown; is_bot?: unknown };
    text?: unknown;
  };
  if (chat?.type !== "private" || typeof text !== "string") return { kind: "ignored" };
  const chatId = asSafeId(chat.id);
  const userId = asSafeId(from?.id);
  if (chatId == null || userId == null || from?.is_bot === true || userId !== chatId) {
    return { kind: "ignored" };
  }
  const start = START_RE.exec(text.trim());
  if (start) return { kind: "start", chatId, userId, token: start[1] ?? null };
  if (STOP_RE.test(text.trim())) return { kind: "stop", chatId };
  return { kind: "ignored" };
}

async function handleStart(
  command: Extract<TelegramCommand, { kind: "start" }>,
  now: Date,
): Promise<TelegramUpdateResult> {
  if (command.token == null) return "start_help";
  if (!isLinkTokenFormat(command.token)) return "invalid_link";
  const request = await consumeLinkToken({
    tokenHash: hashLinkToken(command.token),
    telegramChatId: command.chatId,
    now,
  });
  if (!request) return "invalid_link";

  const existing = await readActiveLinkForChat(command.chatId);
  if (existing && existing.wallet_address !== request.wallet_address) {
    return "chat_linked_elsewhere";
  }
  if (existing) return "already_linked";
  try {
    await upsertWalletLink({
      walletAddress: request.wallet_address,
      telegramUserId: command.userId,
      telegramChatId: command.chatId,
      now,
    });
  } catch (error) {
    if (error instanceof TelegramChatLinkedError) return "chat_linked_elsewhere";
    throw error;
  }
  return "linked";
}

export async function handleTelegramCommand(
  command: TelegramCommand,
  now = new Date(),
): Promise<TelegramUpdateResult> {
  if (command.kind === "start") return handleStart(command, now);
  if (command.kind === "stop") {
    const disabled = await disableLinkForChat(command.chatId, "user_requested", now);
    return disabled > 0 ? "stopped" : "not_linked";
  }
  return "ignored";
}

export function telegramReply(result: TelegramUpdateResult): string | null {
  switch (result) {
    case "linked":
      return TELEGRAM_REPLIES.linked;
    case "already_linked":
      return TELEGRAM_REPLIES.alreadyLinked;
    case "chat_linked_elsewhere":
      return TELEGRAM_REPLIES.chatLinkedElsewhere;
    case "invalid_link":
      return TELEGRAM_REPLIES.invalidLink;
    case "start_help":
      return TELEGRAM_REPLIES.start;
    case "stopped":
      return TELEGRAM_REPLIES.stopped;
    case "not_linked":
      return TELEGRAM_REPLIES.notLinked;
    default:
      return null;
  }
}
