import { NextResponse } from "next/server";
import {
  requireOwnedDecision,
  updateOwnedDecision,
} from "../../../../lib/db/store";
import {
  decisionAccessResponse,
  missingWalletResponse,
  walletFromBody,
} from "../../../../lib/ora/wallet-request";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      decisionId?: string;
      txHash?: `0x${string}`;
      walletAddress?: unknown;
      wallet?: unknown;
    };
    const wallet = walletFromBody(body);
    if (!wallet) return missingWalletResponse();
    if (!body.decisionId || !body.txHash) {
      return NextResponse.json({ error: "Missing transaction." }, { status: 400 });
    }

    const access = await requireOwnedDecision(body.decisionId, wallet);
    if ("error" in access) return decisionAccessResponse(access.error);

    if (access.record.executionStatus === "success") {
      return NextResponse.json({
        txHash: access.record.txHash ?? body.txHash,
        status: "success",
        record: access.record,
      });
    }

    const updated = await updateOwnedDecision(body.decisionId, wallet, {
      txHash: body.txHash,
      executionStatus: "pending",
    });
    if ("error" in updated) return decisionAccessResponse(updated.error);

    return NextResponse.json({
      txHash: body.txHash,
      status: "pending",
      record: updated.record,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not record transaction.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
