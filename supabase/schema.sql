-- Ora production schema. Run in the Supabase SQL editor.
-- Service role only; RLS is enabled with no anon policies.

create table if not exists public.decisions (
  id text primary key,
  wallet_address text not null,
  timestamp timestamptz not null,
  market jsonb not null,
  snapshot jsonb not null,
  decision text not null,
  reason text not null,
  requested_amount double precision,
  quote_price double precision,
  quoted_usdg double precision,
  quoted_at timestamptz,
  validated_block bigint,
  execution_price double precision,
  tx_hash text,
  execution_status text,
  blocked_reason text,
  credit_acquired double precision,
  total_usdg_paid double precision,
  confirmed_at timestamptz,
  reasoning jsonb,
  min_discount_percent double precision,
  evaluated_requested_credit double precision,
  target_id text,
  created_at timestamptz not null default now()
);

create index if not exists decisions_wallet_timestamp_idx
  on public.decisions (wallet_address, timestamp desc);

-- One onchain purchase confirms at most one decision.
create unique index if not exists decisions_confirmed_tx_hash_key
  on public.decisions (lower(tx_hash))
  where execution_status = 'success' and tx_hash is not null;

create table if not exists public.settings (
  wallet_address text primary key,
  requested_credit double precision not null,
  spending_limit_usdg double precision not null,
  min_discount_percent double precision not null,
  updated_at timestamptz not null default now()
);

-- One row per scheduled observation slot, claimed as 'incomplete' before Orbio is read.
-- Only 'succeeded' rows carry market state.
create table if not exists public.market_observations (
  slot_start timestamptz primary key,
  cadence_seconds integer not null,
  outcome text not null,
  attempted_at timestamptz not null,
  completed_at timestamptz,
  levels jsonb,
  min_buy_credit_atoms bigint,
  reported_total_credit_atoms bigint,
  fingerprint text,
  http_status integer,
  error_detail text,
  constraint market_observations_slot_check
    check (cadence_seconds > 0 and extract(epoch from slot_start)::bigint % cadence_seconds = 0),
  constraint market_observations_outcome_check
    check (outcome in ('succeeded', 'incomplete', 'timeout', 'network', 'http_error', 'invalid_payload')),
  constraint market_observations_result_check check (
    (outcome = 'succeeded'
      and completed_at is not null
      and jsonb_typeof(levels) = 'array'
      and fingerprint is not null
      and (min_buy_credit_atoms is null or min_buy_credit_atoms > 0)
      and (reported_total_credit_atoms is null or reported_total_credit_atoms >= 0)
      and http_status is null
      and error_detail is null)
    or (outcome <> 'succeeded'
      and levels is null
      and fingerprint is null
      and min_buy_credit_atoms is null
      and reported_total_credit_atoms is null
      and (completed_at is null) = (outcome = 'incomplete')
      and (http_status is not null) = (outcome = 'http_error'))
  )
);

create index if not exists decisions_target_id_idx
  on public.decisions (target_id);

create table if not exists public.procurement_targets (
  id text primary key,
  wallet_address text not null,
  requested_credit double precision not null,
  min_discount_percent double precision not null,
  max_spend_usdg double precision not null,
  status text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  cancelled_at timestamptz,
  fulfilled_at timestamptz,
  active_decision_id text,
  fulfilled_decision_id text,
  last_evaluated_at timestamptz,
  last_evaluation_action text,
  last_evaluation_reason text,
  last_requested_amount double precision,
  last_executable_discount_percent double precision,
  last_executable_total_usdg double precision,
  ready_since timestamptz,
  constraint procurement_targets_credit_check
    check (requested_credit > 0),
  constraint procurement_targets_discount_check
    check (min_discount_percent >= 0 and min_discount_percent <= 100),
  constraint procurement_targets_spend_check
    check (max_spend_usdg > 0),
  constraint procurement_targets_status_check
    check (status in ('WATCHING', 'READY', 'FULFILLED', 'CANCELLED')),
  constraint procurement_targets_cancelled_check
    check ((status = 'CANCELLED') = (cancelled_at is not null)),
  constraint procurement_targets_fulfilled_check
    check (
      (status = 'FULFILLED' and fulfilled_at is not null and fulfilled_decision_id is not null)
      or (status <> 'FULFILLED' and fulfilled_at is null and fulfilled_decision_id is null)
    ),
  constraint procurement_targets_ready_since_check
    check ((status = 'READY') = (ready_since is not null))
);

-- ready_since marks the start of the current READY period for every write path.
create or replace function public.procurement_targets_track_ready_since()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'READY' then
    if tg_op = 'UPDATE' and old.status = 'READY' then
      new.ready_since := coalesce(old.ready_since, new.ready_since, now());
    else
      new.ready_since := now();
    end if;
  else
    new.ready_since := null;
  end if;
  return new;
end;
$$;

drop trigger if exists procurement_targets_ready_since on public.procurement_targets;
create trigger procurement_targets_ready_since
  before insert or update on public.procurement_targets
  for each row execute function public.procurement_targets_track_ready_since();

create unique index if not exists procurement_targets_one_open_per_wallet
  on public.procurement_targets (wallet_address)
  where status in ('WATCHING', 'READY');

create index if not exists procurement_targets_wallet_created_idx
  on public.procurement_targets (wallet_address, created_at desc);

create index if not exists procurement_targets_status_idx
  on public.procurement_targets (status);

-- One alert record per target READY period and channel.
-- Rows are created only when the scheduler moves a target from WATCHING to READY.
create table if not exists public.target_alerts (
  id text primary key,
  target_id text not null references public.procurement_targets (id),
  wallet_address text not null,
  channel text not null,
  ready_since timestamptz not null,
  status text not null,
  attempts integer not null default 0,
  next_attempt_at timestamptz,
  claimed_at timestamptz,
  sent_at timestamptz,
  telegram_message_id bigint,
  last_error text,
  created_at timestamptz not null default now(),
  constraint target_alerts_channel_check
    check (channel in ('telegram')),
  constraint target_alerts_status_check
    check (status in (
      'pending',
      'sending',
      'sent',
      'failed_retryable',
      'failed_permanent',
      'unknown',
      'skipped',
      'suppressed'
    )),
  constraint target_alerts_attempts_check
    check (attempts >= 0),
  constraint target_alerts_sent_check
    check ((status = 'sent') = (sent_at is not null)),
  constraint target_alerts_period_key
    unique (target_id, ready_since, channel)
);

create index if not exists target_alerts_target_channel_created_idx
  on public.target_alerts (target_id, channel, created_at desc);

create index if not exists target_alerts_due_idx
  on public.target_alerts (next_attempt_at)
  where status in ('pending', 'failed_retryable');

-- Wallet signature challenges and one-time Telegram deep-link tokens (SHA-256 only).
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

-- One row per wallet; a Telegram chat is actively linked to at most one wallet.
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

create unique index if not exists telegram_links_active_chat_key
  on public.telegram_links (telegram_chat_id)
  where disabled_at is null;

alter table public.decisions enable row level security;
alter table public.settings enable row level security;
alter table public.market_observations enable row level security;
alter table public.procurement_targets enable row level security;
alter table public.target_alerts enable row level security;
alter table public.telegram_link_requests enable row level security;
alter table public.telegram_links enable row level security;
