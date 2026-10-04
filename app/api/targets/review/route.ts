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
import {
  quoteTargetTerms,
  targetPurchaseInFlight,
} from "../../../../lib/ora/watch-targets";
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

    if (await targetPurchaseInFlight(access.target)) {
      return NextResponse.json(
        {
          error:
            "A purchase for this target is already awaiting signature or confirmation.",
          code: "purchase_in_flight",
          target: access.target,
        },
        { status: 409 },
      );
    }

    const market = await readMarketSnapshot();
    const evaluation = await evaluateTarget(
      market,
      paramsFromTarget(access.target),
      quoteTargetTerms,
    );
    if (evaluation.outcome === "INCONCLUSIVE") {
      return NextResponse.json(
        {
          error:
            "Ora could not confirm an executable quote right now. The target is unchanged. Try again shortly.",
          code: "inconclusive",
          target: access.target,
        },
        { status: 503 },
      );
    }

    const target = await persistTargetEvaluation(access.target, evaluation);
    if (!target) {
      const latest = await requireOwnedTarget(access.target.id, wallet);
      return NextResponse.json(
        {
          error: "This target changed while Ora was checking it. Try again.",
          code: "target_changed",
          target: "target" in latest ? latest.target : access.target,
        },
        { status: 409 },
      );
    }

    if (evaluation.outcome !== "QUALIFIED" || evaluation.decision.action !== "BUY") {
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
