import { NextResponse } from "next/server";
import {
  insertTarget,
  OpenTargetExistsError,
  readTargetForWallet,
} from "../../../lib/db/targets";
import { validateTargetFields } from "../../../lib/ora/target";
import {
  missingWalletResponse,
  walletFromBody,
  walletFromRequestUrl,
} from "../../../lib/ora/wallet-request";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const wallet = walletFromRequestUrl(request);
  if (!wallet) return NextResponse.json({ target: null });
  try {
    const target = await readTargetForWallet(wallet);
    return NextResponse.json({ target });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not read target.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      walletAddress?: unknown;
      wallet?: unknown;
      requestedCredit?: unknown;
      minDiscountPercent?: unknown;
      maxSpendUsdg?: unknown;
      spendingLimitUsdg?: unknown;
    };
    const wallet = walletFromBody(body);
    if (!wallet) return missingWalletResponse();
    const fields = validateTargetFields(body);
    if (!fields.ok) {
      return NextResponse.json({ error: fields.error }, { status: 400 });
    }
    const target = await insertTarget(wallet, fields.params);
    return NextResponse.json({ target }, { status: 201 });
  } catch (error) {
    if (error instanceof OpenTargetExistsError) {
      return NextResponse.json(
        { error: error.message, code: "open_target_exists" },
        { status: 409 },
      );
    }
    const message =
      error instanceof Error ? error.message : "Could not create target.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
