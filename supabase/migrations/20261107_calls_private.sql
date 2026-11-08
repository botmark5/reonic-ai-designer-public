-- Session B (web): calls hold customer names, addresses and full transcripts, so the anon key must not read them.
-- The live-call screen reads calls through GET /api/calls (service role); the planner inbox gets realtime from
-- `designs` only. Idempotent. Apply after supabase/schema.sql (which now also omits this policy).
drop policy if exists "anon read calls" on public.calls;
alter table public.calls enable row level security;
-- No select policy for anon/authenticated = no rows. Realtime on calls then delivers nothing to the browser,
-- so take calls out of the realtime publication as well (designs stays in it).
do $$
begin
  if exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'calls') then
    alter publication supabase_realtime drop table public.calls;
  end if;
end $$;
