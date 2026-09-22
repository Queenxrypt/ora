import { NextResponse } from "next/server";
import { readSettings, writeSettings } from "../../../lib/db/store";
import {
  missingWalletResponse,
  walletFromBody,
  walletFromRequestUrl,
} from "../../../lib/ora/wallet-request";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const wallet = walletFromRequestUrl(request);
  const settings = await readSettings(wallet);
  return NextResponse.json({ settings });
}

export async function PUT(request: Request) {
  const body = await request.json();
  const wallet = walletFromBody(body);
  if (!wallet) return missingWalletResponse();
  try {
    const settings = await writeSettings({ ...body, walletAddress: wallet });
    return NextResponse.json({ settings });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not save settings.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
