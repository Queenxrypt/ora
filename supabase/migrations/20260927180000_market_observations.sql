-- One row per scheduled observation slot, claimed as 'incomplete' before Orbio is read.
-- Only 'succeeded' rows carry market state; every other outcome records that no valid
-- observation was obtained for the slot. Levels hold exact CREDIT atoms per discount level.
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

alter table public.market_observations enable row level security;

notify pgrst, 'reload schema';
