import { NextResponse } from "next/server";
import { CONTRACTS } from "../../../../lib/orbio/contracts";
import { publicClient } from "../../../../lib/orbio/exchange";
import {
  requireOwnedDecision,
  updateOwnedDecision,
} from "../../../../lib/db/store";
import { normalizeWalletAddress } from "../../../../lib/ora/wallet";
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
      creditAcquired?: number;
      totalUsdgPaid?: number;
      quotePrice?: number;
      walletAddress?: unknown;
      wallet?: unknown;
    };
    const wallet = walletFromBody(body);
    if (!wallet) return missingWalletResponse();
    if (!body.decisionId || !isHash(body.txHash)) {
      return NextResponse.json({ error: "Missing transaction." }, { status: 400 });
    }
    const txHash = body.txHash;

    const access = await requireOwnedDecision(body.decisionId, wallet);
    if ("error" in access) return decisionAccessResponse(access.error);
    const current = access.record;

    if (current.executionStatus === "success") {
      return NextResponse.json({
        txHash: current.txHash ?? txHash,
        status: "success",
        record: current,
      });
    }

    if (current.txHash && current.txHash.toLowerCase() !== txHash.toLowerCase()) {
      return NextResponse.json(
        { error: "Transaction hash does not match this decision." },
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

    const from = normalizeWalletAddress(tx.from);
    if (from !== wallet) {
      return NextResponse.json(
        { error: "Transaction sender does not match this wallet." },
        { status: 403 },
      );
    }

    const to = normalizeWalletAddress(tx.to);
    const exchange = normalizeWalletAddress(CONTRACTS.exchange);
    if (!to || !exchange || to !== exchange) {
      await updateOwnedDecision(body.decisionId, wallet, {
        txHash,
        executionStatus: "failed",
        blockedReason: "Transaction is not a buyAndActivate call to the exchange.",
      });
      return NextResponse.json(
        { error: "Transaction is not a purchase on the Orbio exchange." },
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

    const record = await updateOwnedDecision(body.decisionId, wallet, {
      txHash,
      executionStatus: "success",
      creditAcquired: body.creditAcquired ?? current.creditAcquired ?? current.requestedAmount,
      totalUsdgPaid: body.totalUsdgPaid ?? current.totalUsdgPaid ?? current.quotedUsdg,
      executionPrice: body.quotePrice ?? current.executionPrice ?? current.quotePrice,
      confirmedAt: new Date().toISOString(),
    });
    if ("error" in record) return decisionAccessResponse(record.error);

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
