import { NextResponse } from "next/server";
import {
  requireOwnedTarget,
  targetAccessResponse,
} from "../../../../lib/db/targets";
import { isOpenTargetStatus } from "../../../../lib/ora/target";
import { evaluateOwnedTargetLive } from "../../../../lib/ora/watch-targets";
import {
  missingWalletResponse,
  walletFromBody,
} from "../../../../lib/ora/wallet-request";

export const dynamic = "force-dynamic";
export const maxDuration = 20;

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      walletAddress?: unknown;
      wallet?: unknown;
      targetId?: unknown;
    };
    const wallet = walletFromBody(body);
    if (!wallet) return missingWalletResponse();
    if (typeof body.targetId !== "string" || !body.targetId.trim()) {
      return NextResponse.json({ error: "Missing target." }, { status: 400 });
    }

    const access = await requireOwnedTarget(body.targetId.trim(), wallet);
    if ("error" in access) {
      const denied = targetAccessResponse(access.error);
      return NextResponse.json({ error: denied.error }, { status: denied.status });
    }
    if (!isOpenTargetStatus(access.target.status)) {
      return NextResponse.json({ target: access.target });
    }

    const target =
      (await evaluateOwnedTargetLive(access.target)) ?? access.target;
    return NextResponse.json({ target });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not evaluate target.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
