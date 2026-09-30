import { NextResponse } from "next/server";
import { appendDecision } from "../../../../lib/db/store";
import {
  requireOwnedTarget,
  setActiveDecision,
  persistTargetEvaluation,
  targetAccessResponse,
} from "../../../../lib/db/targets";
import { recordFromDecision } from "../../../../lib/ora/record";
import {
  evaluateTarget,
  isOpenTargetStatus,
  paramsFromTarget,
} from "../../../../lib/ora/target";
import { quoteTargetTerms } from "../../../../lib/ora/watch-targets";
import { readMarketSnapshot } from "../../../../lib/orbio/market";
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
      const denied = targetAccessResponse(
        access.target.status === "CANCELLED" ? "cancelled" : "fulfilled",
      );
      return NextResponse.json({ error: denied.error, target: access.target }, { status: denied.status });
    }

    const market = await readMarketSnapshot();
    const evaluation = await evaluateTarget(
      market,
      paramsFromTarget(access.target),
      quoteTargetTerms,
    );
    const target =
      (await persistTargetEvaluation(
        access.target.id,
        wallet,
        evaluation,
      )) ?? access.target;

    if (evaluation.status !== "READY" || evaluation.decision.action !== "BUY") {
      return NextResponse.json(
        {
          error:
            "The CREDIT market no longer qualifies for this target. Ora is watching again.",
          code: "not_ready",
          target,
        },
        { status: 409 },
      );
    }

    const record = await appendDecision(
      recordFromDecision(evaluation.decision, {
        executionStatus: "none",
        walletAddress: wallet,
        targetId: access.target.id,
      }),
    );
    const linked =
      (await setActiveDecision(access.target.id, wallet, record.id)) ?? target;

    return NextResponse.json({
      target: linked,
      decision: evaluation.decision,
      record,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not start target review.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
