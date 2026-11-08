-- Reonic AI Designer: Supabase schema (owner: session B / web).
-- Apply in the Supabase SQL editor or with `supabase db push`. Idempotent where practical.
-- Access model: the browser never reads Supabase. Every read and write goes through server routes (service role).
-- Every write goes through server routes that use the service-role key (which bypasses RLS).

create extension if not exists pgcrypto;

-- Voice calls (session D writes them; the planner inbox shows them live).
create table if not exists public.calls (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  status        text not null default 'live',          -- e.g. live | ended | failed
  customer_name text,
  address       text,
  facts         jsonb not null default '{}'::jsonb,     -- partial Home collected during the call
  transcript    jsonb not null default '[]'::jsonb,     -- [{ role, text, at }]
  summary       text
);

-- Designs: one per home being planned, from a call or typed in by the planner.
create table if not exists public.designs (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  call_id     uuid references public.calls(id) on delete set null,
  source      text not null default 'planner' check (source in ('voice', 'planner', 'form')),
  status      text not null default 'draft'   check (status in ('draft', 'review', 'sent')),
  customer_name text,                                   -- "Weber, Augsburg" (from the call or typed by the planner)
  address       text,
  home        jsonb not null,                           -- Home (web/src/lib/types.ts)
  locks       jsonb not null default '{}'::jsonb,       -- Locks
  design      jsonb,                                    -- DesignResponse from the engine
  explanation text
);
-- columns added after the first version (safe to re-run)
alter table public.designs add column if not exists customer_name text;
alter table public.designs add column if not exists address text;
create index if not exists designs_created_at_idx on public.designs (created_at desc);
create index if not exists designs_call_id_idx on public.designs (call_id);

-- Every manual change by a planner (audit trail; also measures how often experts override the engine).
create table if not exists public.overrides (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  design_id   uuid not null references public.designs(id) on delete cascade,
  component   text not null,                            -- pv | battery | wallbox | heatpump | home.<field>
  from_value  jsonb,
  to_value    jsonb,
  reason      text,
  by          text
);
create index if not exists overrides_design_id_idx on public.overrides (design_id);

-- Homeowner share links: /offer/[token].
create table if not exists public.shares (
  token            text primary key,
  design_id        uuid not null references public.designs(id) on delete cascade,
  allowed_variants jsonb not null default '[]'::jsonb,  -- variants the installer lets the homeowner choose between
  created_at       timestamptz not null default now()
);
create index if not exists shares_design_id_idx on public.shares (design_id);

-- Row level security: on for every table, with NO policies for anon/authenticated. The browser never reads Supabase;
-- all reads and writes go through server routes with the service role (designs and shares hold customer data and
-- offer tokens; calls hold transcripts). See migrations/20261107_no_anon_reads.sql.
alter table public.calls     enable row level security;
alter table public.designs   enable row level security;
alter table public.overrides enable row level security;
alter table public.shares    enable row level security;
drop policy if exists "anon read calls"   on public.calls;
drop policy if exists "anon read designs" on public.designs;
drop policy if exists "anon read shares"  on public.shares;

-- Full row data on UPDATE events (so realtime clients get old + new values).
alter table public.calls   replica identity full;
alter table public.designs replica identity full;
