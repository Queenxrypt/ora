import { randomUUID } from "node:crypto";
import type { LinkPurpose } from "../telegram/link";
import { normalizeWalletAddress } from "../ora/wallet";
import { supabaseAdmin } from "./supabase";

export type TelegramLinkRequestRow = {
  id: string;
  wallet_address: string;
  purpose: LinkPurpose;
  nonce: string;
  wallet_message: string;
  expires_at: string;
  verified_at: string | null;
  token_hash: string | null;
  token_expires_at: string | null;
  consumed_at: string | null;
  telegram_chat_id: number | null;
  created_at: string;
};

export type TelegramLinkRow = {
  wallet_address: string;
  telegram_user_id: number;
  telegram_chat_id: number;
  linked_at: string;
  disabled_at: string | null;
  disabled_reason: string | null;
  created_at: string;
  updated_at: string;
};

export type TelegramDisabledReason = "user_requested" | "wallet_requested";

const REQUEST_COLUMNS =
  "id, wallet_address, purpose, nonce, wallet_message, expires_at, verified_at, token_hash, token_expires_at, consumed_at, telegram_chat_id, created_at";
const LINK_COLUMNS =
  "wallet_address, telegram_user_id, telegram_chat_id, linked_at, disabled_at, disabled_reason, created_at, updated_at";

function throwIfError(error: { message: string } | null) {
  if (error) throw new Error(error.message);
}

function requireWallet(value: string): `0x${string}` {
  const wallet = normalizeWalletAddress(value);
  if (!wallet) throw new Error("walletAddress is required.");
  return wallet;
}

export class TelegramChatLinkedError extends Error {
  constructor() {
    super("This Telegram chat is already linked to another wallet.");
    this.name = "TelegramChatLinkedError";
  }
}

export async function insertLinkRequest(input: {
  walletAddress: string;
  purpose: LinkPurpose;
  nonce: string;
  walletMessage: string;
  expiresAt: string;
}): Promise<TelegramLinkRequestRow> {
  const { data, error } = await supabaseAdmin()
    .from("telegram_link_requests")
    .insert({
      id: randomUUID(),
      wallet_address: requireWallet(input.walletAddress),
      purpose: input.purpose,
      nonce: input.nonce,
      wallet_message: input.walletMessage,
      expires_at: input.expiresAt,
    })
    .select(REQUEST_COLUMNS)
    .single();
  throwIfError(error);
  if (!data) throw new Error("Link request was not persisted.");
  return data as TelegramLinkRequestRow;
}

export async function readLinkRequest(id: string): Promise<TelegramLinkRequestRow | null> {
  const { data, error } = await supabaseAdmin()
    .from("telegram_link_requests")
    .select(REQUEST_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  throwIfError(error);
  return (data as TelegramLinkRequestRow | null) ?? null;
}

/**
 * Marks a challenge verified exactly once, while it is unexpired. For a link
 * challenge this also stores the deep-link token hash. Returns null when the
 * challenge was already verified, has expired, or does not match.
 */
export async function markLinkRequestVerified(input: {
  id: string;
  walletAddress: string;
  purpose: LinkPurpose;
  now: Date;
  tokenHash?: string;
  tokenExpiresAt?: string;
}): Promise<TelegramLinkRequestRow | null> {
  const nowIso = input.now.toISOString();
  const { data, error } = await supabaseAdmin()
    .from("telegram_link_requests")
    .update({
      verified_at: nowIso,
      ...(input.tokenHash
        ? { token_hash: input.tokenHash, token_expires_at: input.tokenExpiresAt }
        : {}),
    })
    .eq("id", input.id)
    .eq("wallet_address", requireWallet(input.walletAddress))
    .eq("purpose", input.purpose)
    .is("verified_at", null)
    .gt("expires_at", nowIso)
    .select(REQUEST_COLUMNS)
    .maybeSingle();
  throwIfError(error);
  return (data as TelegramLinkRequestRow | null) ?? null;
}

/**
 * Consumes a deep-link token once: only an unconsumed, unexpired token from a
 * verified link challenge matches. Returns null for any other token.
 */
export async function consumeLinkToken(input: {
  tokenHash: string;
  telegramChatId: number;
  now: Date;
}): Promise<TelegramLinkRequestRow | null> {
  const nowIso = input.now.toISOString();
  const { data, error } = await supabaseAdmin()
    .from("telegram_link_requests")
    .update({ consumed_at: nowIso, telegram_chat_id: input.telegramChatId })
    .eq("token_hash", input.tokenHash)
    .eq("purpose", "link")
    .not("verified_at", "is", null)
    .is("consumed_at", null)
    .gt("token_expires_at", nowIso)
    .select(REQUEST_COLUMNS)
    .maybeSingle();
  throwIfError(error);
  return (data as TelegramLinkRequestRow | null) ?? null;
}

export async function readActiveLinkForWallet(
  walletAddress: string,
): Promise<TelegramLinkRow | null> {
  const wallet = normalizeWalletAddress(walletAddress);
  if (!wallet) return null;
  const { data, error } = await supabaseAdmin()
    .from("telegram_links")
    .select(LINK_COLUMNS)
    .eq("wallet_address", wallet)
    .is("disabled_at", null)
    .maybeSingle();
  throwIfError(error);
  return (data as TelegramLinkRow | null) ?? null;
}

export async function readActiveLinkForChat(
  telegramChatId: number,
): Promise<TelegramLinkRow | null> {
  const { data, error } = await supabaseAdmin()
    .from("telegram_links")
    .select(LINK_COLUMNS)
    .eq("telegram_chat_id", telegramChatId)
    .is("disabled_at", null)
    .maybeSingle();
  throwIfError(error);
  return (data as TelegramLinkRow | null) ?? null;
}

/**
 * Points the wallet's single link row at this chat and enables it. The
 * database rejects a chat that is already active for another wallet.
 */
export async function upsertWalletLink(input: {
  walletAddress: string;
  telegramUserId: number;
  telegramChatId: number;
  now: Date;
}): Promise<TelegramLinkRow> {
  const nowIso = input.now.toISOString();
  const { data, error } = await supabaseAdmin()
    .from("telegram_links")
    .upsert(
      {
        wallet_address: requireWallet(input.walletAddress),
        telegram_user_id: input.telegramUserId,
        telegram_chat_id: input.telegramChatId,
        linked_at: nowIso,
        disabled_at: null,
        disabled_reason: null,
        updated_at: nowIso,
      },
      { onConflict: "wallet_address" },
    )
    .select(LINK_COLUMNS)
    .single();
  if ((error as { code?: string } | null)?.code === "23505") {
    throw new TelegramChatLinkedError();
  }
  throwIfError(error);
  if (!data) throw new Error("Telegram link was not persisted.");
  return data as TelegramLinkRow;
}

/** Disables the active link for exactly this chat. Returns how many links were disabled. */
export async function disableLinkForChat(
  telegramChatId: number,
  reason: TelegramDisabledReason,
  now: Date,
): Promise<number> {
  const nowIso = now.toISOString();
  const { data, error } = await supabaseAdmin()
    .from("telegram_links")
    .update({ disabled_at: nowIso, disabled_reason: reason, updated_at: nowIso })
    .eq("telegram_chat_id", telegramChatId)
    .is("disabled_at", null)
    .select("wallet_address");
  throwIfError(error);
  return (data ?? []).length;
}

/** Disables the active link for exactly this wallet. */
export async function disableLinkForWallet(
  walletAddress: string,
  reason: TelegramDisabledReason,
  now: Date,
): Promise<boolean> {
  const nowIso = now.toISOString();
  const { data, error } = await supabaseAdmin()
    .from("telegram_links")
    .update({ disabled_at: nowIso, disabled_reason: reason, updated_at: nowIso })
    .eq("wallet_address", requireWallet(walletAddress))
    .is("disabled_at", null)
    .select("wallet_address");
  throwIfError(error);
  return (data ?? []).length > 0;
}
