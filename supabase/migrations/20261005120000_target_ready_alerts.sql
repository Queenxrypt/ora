-- READY periods and alert records for procurement targets.
--
-- ready_since marks the start of the target's current READY period. The trigger
-- owns it for every write path: it starts on entry to READY, is preserved while
-- the target stays READY, and is cleared when the target leaves READY.
alter table public.procurement_targets
  add column if not exists ready_since timestamptz;

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

-- Targets already READY keep their status and get a READY period start.
-- updated_at is untouched so in-flight watcher writes are not superseded.
update public.procurement_targets
  set ready_since = coalesce(last_evaluated_at, updated_at)
  where status = 'READY' and ready_since is null;

alter table public.procurement_targets
  drop constraint if exists procurement_targets_ready_since_check;
alter table public.procurement_targets
  add constraint procurement_targets_ready_since_check
    check ((status = 'READY') = (ready_since is not null));

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

alter table public.target_alerts enable row level security;

notify pgrst, 'reload schema';
