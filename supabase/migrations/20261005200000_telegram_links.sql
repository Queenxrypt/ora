-- Wallet ↔ Telegram linking for alerts. Service role only; RLS enabled with no anon policies.
--
-- A request starts as a wallet signature challenge. Only after the signature is
-- verified does it carry a deep-link token, stored as SHA-256 only. Telegram's
-- authenticated /start webhook consumes the token once and creates the link.
create table if not exists public.telegram_link_requests (
  id text primary key,
  wallet_address text not null,
  purpose text not null default 'link',
  nonce text not null,
  wallet_message text not null,
  expires_at timestamptz not null,
  verified_at timestamptz,
  token_hash text,
  token_expires_at timestamptz,
  consumed_at timestamptz,
  telegram_chat_id bigint,
  created_at timestamptz not null default now(),
  constraint telegram_link_requests_purpose_check
    check (purpose in ('link', 'unlink')),
  constraint telegram_link_requests_nonce_check
    check (nonce ~ '^[0-9a-f]{32}$'),
  constraint telegram_link_requests_token_hash_check
    check (token_hash is null or token_hash ~ '^[0-9a-f]{64}$'),
  constraint telegram_link_requests_token_pair_check
    check ((token_hash is null) = (token_expires_at is null)),
  constraint telegram_link_requests_token_verified_check
    check (token_hash is null or (verified_at is not null and purpose = 'link')),
  constraint telegram_link_requests_consumed_check
    check (
      (consumed_at is null and telegram_chat_id is null)
      or (consumed_at is not null and token_hash is not null and telegram_chat_id is not null)
    )
);

create unique index if not exists telegram_link_requests_nonce_key
  on public.telegram_link_requests (nonce);

create unique index if not exists telegram_link_requests_token_hash_key
  on public.telegram_link_requests (token_hash)
  where token_hash is not null;

create index if not exists telegram_link_requests_wallet_created_idx
  on public.telegram_link_requests (wallet_address, created_at desc);

-- One row per wallet. A disabled row keeps its history until the wallet links again.
create table if not exists public.telegram_links (
  wallet_address text primary key,
  telegram_user_id bigint not null,
  telegram_chat_id bigint not null,
  linked_at timestamptz not null,
  disabled_at timestamptz,
  disabled_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint telegram_links_disabled_check
    check ((disabled_at is null) = (disabled_reason is null))
);

-- A Telegram chat is actively linked to at most one wallet.
create unique index if not exists telegram_links_active_chat_key
  on public.telegram_links (telegram_chat_id)
  where disabled_at is null;

alter table public.telegram_link_requests enable row level security;
alter table public.telegram_links enable row level security;

notify pgrst, 'reload schema';
