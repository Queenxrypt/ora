import { NextResponse } from "next/server";
import {
  cancelOwnedTarget,
  targetAccessResponse,
} from "../../../../lib/db/targets";
import {
  missingWalletResponse,
  walletFromBody,
} from "../../../../lib/ora/wallet-request";

export const dynamic = "force-dynamic";

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

    const result = await cancelOwnedTarget(body.targetId.trim(), wallet);
    if ("error" in result) {
      const denied = targetAccessResponse(result.error);
      return NextResponse.json({ error: denied.error }, { status: denied.status });
    }
    return NextResponse.json({ target: result.target });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not cancel target.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
