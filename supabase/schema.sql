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

alter table public.decisions enable row level security;
alter table public.settings enable row level security;
alter table public.market_observations enable row level security;
