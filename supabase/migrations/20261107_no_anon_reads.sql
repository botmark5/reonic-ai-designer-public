-- Session B (web): the browser no longer reads Supabase directly. Designs (customer names, addresses) and shares
-- (every offer token) are served by authenticated server routes with the service role. Idempotent; apply after
-- 20261107_calls_private.sql.
drop policy if exists "anon read designs" on public.designs;
drop policy if exists "anon read shares"  on public.shares;
drop policy if exists "anon read calls"   on public.calls;
-- RLS stays enabled with no policies: anon and authenticated roles see no rows.
do $$
begin
  if exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'designs') then
    alter publication supabase_realtime drop table public.designs;
  end if;
end $$;
