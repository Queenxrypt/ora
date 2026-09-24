import { NextResponse } from "next/server";
import { publicClient } from "../../../../lib/orbio/exchange";
import {
  checkCallMatchesDecision,
  checkMinedAfterValidation,
  verifyBuyAndActivateCall,
} from "../../../../lib/orbio/receipt";
import {
  findConfirmedDecisionIdsByTxHash,
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

function isHash(value: unknown): value is `0x${string}` {
  return typeof value === "string" && /^0x[a-fA-F0-9]{64}$/.test(value);
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      decisionId?: string;
      txHash?: unknown;
      walletAddress?: unknown;
      wallet?: unknown;
    };
    const wallet = walletFromBody(body);
    if (!wallet) return missingWalletResponse();
    if (!body.decisionId || !isHash(body.txHash)) {
      return NextResponse.json({ error: "Missing transaction." }, { status: 400 });
    }
    const txHash = body.txHash.toLowerCase() as `0x${string}`;

    const access = await requireOwnedDecision(body.decisionId, wallet);
    if ("error" in access) return decisionAccessResponse(access.error);
    const current = access.record;
    const stored = current.txHash?.toLowerCase();

    if (current.executionStatus === "success") {
      return NextResponse.json({
        txHash: current.txHash ?? txHash,
        status: "success",
        record: current,
      });
    }

    if (current.executionStatus === "pending" && stored === txHash) {
      return NextResponse.json({ txHash, status: "pending", record: current });
    }

    if (stored && stored !== txHash) {
      return NextResponse.json(
        {
          error: "A different transaction is already recorded for this decision.",
          code: "tx_mismatch",
        },
        { status: 409 },
      );
    }

    if (current.executionStatus !== "awaiting_signature" || stored) {
      return NextResponse.json(
        {
          error: "This decision is not awaiting a signed purchase.",
          code: "not_signable",
        },
        { status: 409 },
      );
    }

    const claimed = await findConfirmedDecisionIdsByTxHash(txHash);
    if (claimed.some((id) => id !== current.id)) {
      return NextResponse.json(
        {
          error: "This transaction already confirmed another decision.",
          code: "tx_reused",
        },
        { status: 409 },
      );
    }

    // Not yet visible to the node: record nothing. The receipt route verifies and
    // records this hash once the transaction can be read.
    const tx = await publicClient().getTransaction({ hash: txHash }).catch(() => null);
    if (!tx) {
      return NextResponse.json({ txHash, status: "pending" }, { status: 202 });
    }

    const verified = verifyBuyAndActivateCall(tx, wallet);
    if (!verified.ok) {
      return NextResponse.json(
        { error: verified.error, code: verified.code },
        { status: verified.code === "sender" ? 403 : 409 },
      );
    }
    const matched = checkCallMatchesDecision(verified.call, {
      wallet,
      quotedUsdg: current.quotedUsdg,
    });
    if (!matched.ok) {
      return NextResponse.json(
        { error: matched.error, code: matched.code },
        { status: 409 },
      );
    }
    if (tx.blockNumber != null) {
      const mined = checkMinedAfterValidation(tx.blockNumber, current.validatedBlock);
      if (!mined.ok) {
        return NextResponse.json(
          { error: mined.error, code: mined.code },
          { status: 409 },
        );
      }
    }

    const updated = await updateOwnedDecision(body.decisionId, wallet, {
      txHash,
      executionStatus: "pending",
    });
    if ("error" in updated) return decisionAccessResponse(updated.error);

    return NextResponse.json({
      txHash,
      status: "pending",
      record: updated.record,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not record transaction.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
