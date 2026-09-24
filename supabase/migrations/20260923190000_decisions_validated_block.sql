-- Chain head read by POST /api/execute/validate. A purchase confirms a decision only
-- if it was mined in a later block. Null on rows validated before this column existed.
alter table public.decisions add column if not exists validated_block bigint;
