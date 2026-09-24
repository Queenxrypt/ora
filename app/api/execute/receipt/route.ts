import { NextResponse } from "next/server";
import { publicClient } from "../../../../lib/orbio/exchange";
import {
  checkCallMatchesDecision,
  checkMinedAfterValidation,
  deriveExecution,
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
    // Financial fields in the body (creditAcquired, totalUsdgPaid, quotePrice,
    // executionPrice) are never read: confirmed values come from the receipt.
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

    if (stored && stored !== txHash) {
      return NextResponse.json(
        { error: "Transaction hash does not match this decision." },
        { status: 409 },
      );
    }

    // Only a signable decision, or the purchase confirm already recorded, can settle.
    const receivable = stored
      ? current.executionStatus === "pending"
      : current.executionStatus === "awaiting_signature";
    if (!receivable) {
      return NextResponse.json(
        {
          error: "This decision is not awaiting a purchase receipt.",
          code: "not_receivable",
        },
        { status: 409 },
      );
    }
    if (current.validatedBlock == null) {
      return NextResponse.json(
        {
          error: "This decision has no validated block to confirm against.",
          code: "unvalidated",
        },
        { status: 409 },
      );
    }

    if (current.decision !== "BUY") {
      return NextResponse.json(
        { error: "Only a BUY decision can be confirmed." },
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

    const client = publicClient();
    const tx = await client.getTransaction({ hash: txHash }).catch(() => null);
    if (!tx) {
      return NextResponse.json(
        { status: "pending", txHash },
        { status: 202 },
      );
    }

    const verified = verifyBuyAndActivateCall(tx, wallet);
    if (!verified.ok) {
      if (verified.code === "sender") {
        return NextResponse.json({ error: verified.error }, { status: 403 });
      }
      const failed = await updateOwnedDecision(body.decisionId, wallet, {
        txHash,
        executionStatus: "failed",
        blockedReason: verified.error,
      });
      if ("error" in failed) return decisionAccessResponse(failed.error);
      return NextResponse.json(
        {
          error: "Transaction is not a buyAndActivate purchase on the Orbio exchange.",
          code: verified.code,
          record: failed.record,
        },
        { status: 409 },
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

    const receipt = await client.getTransactionReceipt({ hash: txHash }).catch(() => null);
    if (!receipt) {
      const pending = await updateOwnedDecision(body.decisionId, wallet, {
        txHash,
        executionStatus: "pending",
      });
      if ("error" in pending) return decisionAccessResponse(pending.error);
      return NextResponse.json(
        { status: "pending", txHash, record: pending.record },
        { status: 202 },
      );
    }

    const mined = checkMinedAfterValidation(receipt.blockNumber, current.validatedBlock);
    if (!mined.ok) {
      return NextResponse.json(
        { error: mined.error, code: mined.code },
        { status: 409 },
      );
    }

    if (receipt.status !== "success") {
      const failed = await updateOwnedDecision(body.decisionId, wallet, {
        txHash,
        executionStatus: "failed",
        blockedReason: "Transaction reverted or failed.",
      });
      if ("error" in failed) return decisionAccessResponse(failed.error);
      return NextResponse.json(
        {
          error: "Transaction failed.",
          status: receipt.status,
          record: failed.record,
        },
        { status: 409 },
      );
    }

    const derived = deriveExecution(receipt, { wallet, call: verified.call });
    if (!derived.ok) {
      if (derived.code === "empty") {
        const failed = await updateOwnedDecision(body.decisionId, wallet, {
          txHash,
          executionStatus: "failed",
          blockedReason: derived.error,
        });
        if ("error" in failed) return decisionAccessResponse(failed.error);
      }
      return NextResponse.json(
        { error: derived.error, code: derived.code },
        { status: 409 },
      );
    }
    const execution = derived.execution;

    const record = await updateOwnedDecision(body.decisionId, wallet, {
      txHash,
      executionStatus: "success",
      creditAcquired: execution.creditAcquired,
      totalUsdgPaid: execution.totalUsdgPaid,
      executionPrice: execution.executionPrice,
      confirmedAt: new Date().toISOString(),
    });
    if ("error" in record) {
      if (record.error === "confirmed") {
        const latest = await requireOwnedDecision(body.decisionId, wallet);
        if ("record" in latest && latest.record.txHash?.toLowerCase() === txHash) {
          return NextResponse.json({
            txHash,
            status: "success",
            record: latest.record,
          });
        }
      }
      return decisionAccessResponse(record.error);
    }

    return NextResponse.json({
      txHash,
      status: "success",
      blockNumber: receipt.blockNumber.toString(),
      record: record.record,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Confirmation failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
