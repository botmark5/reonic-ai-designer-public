-- Site-visit form drafts (POST /api/visit) are stored with source 'form'.
-- Until this runs, /api/visit falls back to source 'planner' (the draft still lands in the inbox).
alter table public.designs drop constraint if exists designs_source_check;
alter table public.designs add constraint designs_source_check check (source in ('voice', 'planner', 'form'));
