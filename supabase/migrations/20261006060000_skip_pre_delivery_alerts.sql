-- Telegram delivery starts with this release. Alerts recorded before it were
-- never deliverable and must not be sent late. This selects only pending,
-- never-attempted alerts created before 2026-10-06 00:00 UTC; in production
-- that is exactly the two alerts recorded on 2026-10-05. Alerts created after
-- the boundary are untouched and stay eligible. Nothing is deleted.
do $$
declare
  stale_count integer;
begin
  select count(*) into stale_count
  from public.target_alerts
  where status = 'pending'
    and attempts = 0
    and claimed_at is null
    and sent_at is null
    and created_at < timestamptz '2026-10-06 00:00:00+00';

  if stale_count > 2 then
    raise exception
      'expected at most 2 pending alerts before 2026-10-06 00:00 UTC, found %', stale_count;
  end if;

  update public.target_alerts
  set status = 'skipped',
      last_error = 'created_before_telegram_delivery_enabled'
  where status = 'pending'
    and attempts = 0
    and claimed_at is null
    and sent_at is null
    and created_at < timestamptz '2026-10-06 00:00:00+00';
end
$$;
