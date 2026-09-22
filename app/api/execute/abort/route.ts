import { NextResponse } from "next/server";
import { updateOwnedDecision } from "../../../../lib/db/store";
import {
  decisionAccessResponse,
  missingWalletResponse,
  walletFromBody,
} from "../../../../lib/ora/wallet-request";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      decisionId?: string;
      reason?: string;
      walletAddress?: unknown;
      wallet?: unknown;
    };
    const wallet = walletFromBody(body);
    if (!wallet) return missingWalletResponse();
    if (!body.decisionId) {
      return NextResponse.json({ error: "Missing decision." }, { status: 400 });
    }

    const result = await updateOwnedDecision(body.decisionId, wallet, {
      executionStatus: "failed",
      blockedReason: body.reason ?? "Transaction rejected or failed.",
    });
    if ("error" in result) return decisionAccessResponse(result.error);

    return NextResponse.json({ record: result.record });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not record failure";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
