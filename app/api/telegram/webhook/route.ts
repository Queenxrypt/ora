import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { telegramWebhookSecret } from "../../../../lib/telegram/config";
import {
  handleTelegramCommand,
  parseTelegramCommand,
  telegramReply,
} from "../../../../lib/telegram/webhook";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

const SECRET_HEADER = "x-telegram-bot-api-secret-token";

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function authorized(request: Request): boolean {
  const secret = telegramWebhookSecret();
  if (!secret) return false;
  const header = request.headers.get(SECRET_HEADER);
  if (header == null) return false;
  return timingSafeEqual(digest(header), digest(secret));
}

/**
 * Telegram webhook. Handles private-chat /start <token> and /stop only.
 * The JSON body has no `method`, so Telegram sends nothing back to the chat.
 */
export async function POST(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const update = await request.json().catch(() => null);
  const command = parseTelegramCommand(update);
  if (command.kind === "ignored") {
    return NextResponse.json({ ok: true, result: "ignored" });
  }
  try {
    const result = await handleTelegramCommand(command);
    return NextResponse.json({ ok: true, result, reply: telegramReply(result) });
  } catch (error) {
    console.error("[ora] telegram webhook failed", {
      command: command.kind,
      error: error instanceof Error ? error.name : "unknown",
    });
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
