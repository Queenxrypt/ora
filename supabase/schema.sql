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
  execution_price double precision,
  tx_hash text,
  execution_status text,
  blocked_reason text,
  credit_acquired double precision,
  total_usdg_paid double precision,
  confirmed_at timestamptz,
  reasoning jsonb,
  created_at timestamptz not null default now()
);

create index if not exists decisions_wallet_timestamp_idx
  on public.decisions (wallet_address, timestamp desc);

create table if not exists public.settings (
  wallet_address text primary key,
  requested_credit double precision not null,
  spending_limit_usdg double precision not null,
  min_discount_percent double precision not null,
  updated_at timestamptz not null default now()
);

alter table public.decisions enable row level security;
alter table public.settings enable row level security;
