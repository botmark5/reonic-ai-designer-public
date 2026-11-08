# Session B: web app (planner, reality check, homeowner)
Branch: `web/app`. Model: Opus. Read first: CLAUDE.md, docs/PLAN.md, docs/api.md, docs/design/README.md,
docs/design/tokens.json, docs/design/assets/. Mockups of the 4 screens: Mark will share screenshots.

Skills: superpowers:writing-plans, then superpowers:subagent-driven-development; superpowers:test-driven-development
for logic; superpowers:systematic-debugging on failures; for UI: design-taste-frontend, impeccable, emil-design-eng.
Plan first (plan mode), show me the plan, wait for my OK.

Stack: Next.js in web/ (App Router, TS, Tailwind v4, shadcn Base UI "Nova", Geist), @supabase/supabase-js,
Anthropic SDK on server routes only. Secrets only in web/.env.local (never committed).

Ownership (avoid conflicts with parallel sessions):
- YOU own: web/src/app (pages, layout, /api/agent), web/src/components/{planner,reality,homeowner,ui},
  web/src/lib/{types.ts,engine.ts,supabase.ts,agent.ts}, supabase/schema.sql.
- Do NOT touch web/src/components/house3d (session C) or web/src/app/api/{voice,solar} (session D).

## Milestone 1 (push within ~30 min; sessions C and D wait for it)
1. Theme: map docs/design/tokens.json to Tailwind v4 theme variables in globals.css (light + dark), Geist + Geist Mono,
   Reonic logo (docs/design/assets → web/public/brand) in the header with "AI Designer" beside it.
2. web/src/lib/types.ts: TypeScript types matching docs/api.md exactly (Home, Locks, DesignResponse, ValidateResponse,
   EvalResponse, ProjectResponse).
3. web/src/lib/engine.ts: engine client using ENGINE_URL. If ENGINE_URL is unset, a deterministic MOCK with the same
   signatures and realistic outputs (kWp ≈ annual kWh / 1000 + EV bonus, snapped to 0.45 kWp steps; battery ≈ PV snapped to
   5/7/10/14 kWh; wallbox if EV; heat pump null). Clearly marked as mock.
4. supabase/schema.sql: tables
   - calls (id uuid pk, created_at, status text, customer_name, address, facts jsonb, transcript jsonb, summary text)
   - designs (id uuid pk, created_at, call_id fk null, source text ['voice','planner'], status text ['draft','review','sent'],
     home jsonb, locks jsonb, design jsonb, explanation text)
   - overrides (id, created_at, design_id fk, component text, from_value jsonb, to_value jsonb, reason text, by text)
   - shares (token text pk, design_id fk, allowed_variants jsonb, created_at)
   Enable realtime on calls + designs. RLS on: anon may SELECT designs/calls/shares; all writes via service role only.
5. web/src/lib/supabase.ts: browser client (anon key) + server-only client (service role).
Commit, push web/app, open a PR, then tell me "milestone 1 pushed".

## Milestone 2: screens (match docs/design and the mockups)
- `/` planner: left = inbox of designs (Supabase realtime, newest first, "From call" badge) + Home inputs form;
  centre = customer title, "Drafted by AI" badge, 4 SystemCards (PV, battery, wallbox, heat pump: size + unit,
  ConfidenceRange, up to 3 reasons, Lock/Change), refine box; right = "Why this design" (streamed), similar homes table,
  physics numbers, validation flags. Footer: "Compare with expert", "Send to homeowner" (creates a shares row),
  primary "Use this design".
- Refine agent: POST /api/agent, Claude claude-sonnet-5-5 with tools update_inputs, lock_component, unlock_component,
  run_design, explain_design, compare_with_expert. Sizes come ONLY from run_design (the engine), never from the model.
  Stream text; return new design + a diff ("PV 9.9 → 10.8 kWp, wallbox added"); UI highlights changed values.
- `/reality`: pick a held-out project → ours vs expert vs variant range with verdict badges; metric tiles from /eval
  (placeholders until the engine is live).
- `/offer/[token]`: homeowner view, mobile-first, plain language, choices only within allowed variants, stats,
  "Listen to your offer" button (session D wires it), and a `<div id="house3d-slot">` where session C's House3D goes.
- Every manual change writes an overrides row (component, from, to, reason, by, design_id).
Quality: responsive, keyboard accessible, both themes, loading and empty states, no lorem.
Deploy on Vercel (GitHub account botmark5) once `/` works on mock data. Tick docs/PLAN.md, PR per milestone.
