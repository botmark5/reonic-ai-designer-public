# Web milestone 2: plan (session B)

Goal: the four mockup screens (docs/design/mockups) on real components, real engine (offline fallback), Supabase when configured.
Order = demo value: planner → agent → live call → offer → reality. One PR per step, merged when tests/build/lint are green.

## Shared foundations (step 1)
- `lib/format.ts` (kWp 1 decimal, thin grouping, %, €, relative time) and `lib/diff.ts` (design A → B: "PV 9.9 → 10.8 kWp",
  "wallbox added", changed component set). Both TDD (vitest).
- UI primitives restyled to tokens: Button = pill (primary / secondary / ghost), StatusBadge (dot + word: ai, success, warning,
  critical, neutral), Field (visible label), Segmented control. Header nav: Designs · Live call · Reality check, theme toggle.
- `lib/store.ts` (server-only): designs / overrides / shares through `getServerSupabase()`, or an in-memory store when
  Supabase is not configured (dev and demo still work). Routes: `POST/PATCH /api/designs`, `POST /api/overrides`, `POST /api/shares`.

## Planner `/` (step 2): mockup 2
- Left: Inbox (designs newest first, realtime INSERT/UPDATE, "From call" badge, status), "The home" form (consumption, price,
  household, EV km, heating + demand, existing PV/battery, roof). Any edit re-runs the design (debounced) and writes an override row.
- Centre: "Drafted by AI" badge, customer title, "Based on N similar homes", actions (Compare with expert · Send to homeowner ·
  primary "Use this design"), refine box, "Changed" line, 4 SystemCards (size + unit with count-up, ConfidenceRange, up to 3
  reasons, status badge from /validate, Lock / Change). Heat pump card shows the engine's option ("Add as option").
- Right: "Why this design" (streamed /explain), similar homes table, physics tiles (yield, own use, self-sufficiency, checks).
- Offline estimate badge whenever `served.source === "offline"`.

## Refine agent `/api/agent` (step 3)
- Claude `claude-sonnet-5-5`, tools: update_inputs, lock_component, unlock_component, run_design, explain_design,
  compare_with_expert. Sizes only from run_design (engine). NDJSON stream: text deltas, tool events, final design + diff.
- Without ANTHROPIC_API_KEY: falls back to engine `/refine` (keyword/Haiku on the engine side).

## Live call `/live` (step 4): mockup 1, planner-side big screen
- Subscribes to `calls` (realtime): transcript bubbles, "What I have so far" checklist from `facts`, draft design re-run as facts
  arrive. "Play demo call" replays a scripted call when no live call exists (demo never blank).

## Homeowner `/offer/[token]` (step 5): mockup 4
- Mobile-first, plain words; choices only within `allowed_variants`; stats (yield, own use, savings, payback); "Listen to your
  offer" button (session D wires it); `<div id="house3d-slot">` + `<House3D>` once session C ships it. Token `demo` always works.

## Reality check `/reality` (step 6): mockup 3
- One held-out home: ours vs expert vs variant range with verdict badges. Tiles from /eval (model vs rule of thumb), A → B transfer.
- BLOCKED-ish: the engine has no "list held-out project ids" endpoint; until Cala adds one, use ids from /eval if present, else
  a project-id input + recent similar-home ids.

## Done when
Each screen: responsive (375 → 1440), keyboard reachable, both themes, loading + empty states, no lorem; impeccable-style
critique pass, findings fixed. Then one fresh reviewer over the whole milestone, deploy on Vercel (needs Mark: account).
