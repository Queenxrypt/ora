import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import {
  claimObservationSlot,
  completeObservation,
} from "../../../lib/db/observations";
import {
  fetchObservedBook,
  observationCadenceSeconds,
  observationSlot,
} from "../../../lib/orbio/book-observation";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Telegram notifications must finish this long after the request starts. */
const NOTIFICATION_DEADLINE_MS = 25_000;

const NO_STORE = { "Cache-Control": "no-store" };

function respond(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** Only the Authorization header is read; the secret is never taken from the URL. */
function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  return timingSafeEqual(digest(header), digest(`Bearer ${secret}`));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

export async function GET(request: Request) {
  const startedAt = Date.now();
  if (!authorized(request)) {
    return respond({ error: "Unauthorized." }, 401);
  }

  let cadenceSeconds: number;
  try {
    cadenceSeconds = observationCadenceSeconds();
  } catch (error) {
    console.error("Market observation misconfigured:", message(error));
    return respond({ error: "Market observation is misconfigured." }, 503);
  }

  const attemptedAt = new Date();
  const slot = observationSlot(attemptedAt, cadenceSeconds);
  const slotStart = slot.toISOString();

  try {
    const claimed = await claimObservationSlot(slot, cadenceSeconds, attemptedAt);
    if (!claimed) return respond({ slotStart, status: "duplicate" });
  } catch (error) {
    console.error("Market observation claim failed:", message(error));
    return respond({ error: "Market observation could not be claimed.", slotStart }, 500);
  }

  const result = await fetchObservedBook();

  try {
    const completed = await completeObservation(slot, result, new Date());
    if (!completed) throw new Error("claimed slot is no longer incomplete");
  } catch (error) {
    console.error("Market observation write failed:", message(error));
    return respond({ error: "Market observation could not be recorded.", slotStart }, 500);
  }

  if (result.outcome === "succeeded") {
    try {
      const { evaluateOpenTargetsAfterObservation } = await import(
        "../../../lib/ora/watch-targets"
      );
      await evaluateOpenTargetsAfterObservation(result.book);
    } catch (error) {
      console.error(
        "Procurement target evaluation after observation failed:",
        message(error),
      );
    }
  }

  try {
    const { deliverTelegramNotifications } = await import("../../../lib/telegram/notify");
    await deliverTelegramNotifications({ deadline: startedAt + NOTIFICATION_DEADLINE_MS });
  } catch (error) {
    console.error("Telegram notifications after observation failed:", message(error));
  }

  return respond({ slotStart, outcome: result.outcome });
}
