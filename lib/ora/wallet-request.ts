import { NextResponse } from "next/server";
import { normalizeWalletAddress } from "./wallet";

export function walletFromRequestUrl(request: Request): `0x${string}` | null {
  const url = new URL(request.url);
  return normalizeWalletAddress(
    url.searchParams.get("wallet") ?? url.searchParams.get("walletAddress"),
  );
}

export function walletFromBody(body: {
  walletAddress?: unknown;
  wallet?: unknown;
}): `0x${string}` | null {
  return normalizeWalletAddress(body.walletAddress ?? body.wallet);
}

export function missingWalletResponse() {
  return NextResponse.json(
    { error: "walletAddress is required." },
    { status: 400 },
  );
}

export function decisionAccessResponse(error: "missing" | "forbidden") {
  if (error === "missing") {
    return NextResponse.json({ error: "Unknown decision." }, { status: 404 });
  }
  return NextResponse.json(
    { error: "This decision does not belong to this wallet." },
    { status: 403 },
  );
}
