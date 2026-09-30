-- Procurement targets: standing CREDIT procurement objectives.
-- Service role only; RLS enabled with no anon policies.

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
    )
);

create unique index if not exists procurement_targets_one_open_per_wallet
  on public.procurement_targets (wallet_address)
  where status in ('WATCHING', 'READY');

create index if not exists procurement_targets_wallet_created_idx
  on public.procurement_targets (wallet_address, created_at desc);

create index if not exists procurement_targets_status_idx
  on public.procurement_targets (status);

alter table public.decisions
  add column if not exists target_id text;

create index if not exists decisions_target_id_idx
  on public.decisions (target_id);

alter table public.procurement_targets enable row level security;
