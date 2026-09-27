-- Criteria a decision was evaluated against, written once when the decision is created.
-- A BUY's CREDIT size is requested_amount; evaluated_requested_credit holds it for WAIT.
-- Null on decisions recorded before this migration.
alter table public.decisions
  add column if not exists min_discount_percent double precision,
  add column if not exists evaluated_requested_credit double precision;

notify pgrst, 'reload schema';
