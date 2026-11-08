# Plan & status (mirror of the shared Claude doc "Reonic Hack — Plan & Tracker")
Agents: tick tasks here when done (`- [x]`) and commit. Add blockers as "BLOCKED: …" under the task.
Gates: 19:00 checkpoint · 23:00 MINIMUM DONE · no freeze (Mark, 8 Nov: keep going until the stage) · Sun 13:30 submit.

**Status, morning of 8 Nov (e-spare, from git, GitHub and the live engine):**
- **Production deploys from main again** (Vercel: main at #120 deployed). The hero PRs #89 /live and #103 /offer are merged.
- **The engine is redeployed (Cala)** with #100 (GET /heldout: 315 held-out ids, 7 example cases), #107 (/eval by_band) and the one-smaller-one-larger alternatives. Runbook numbers re-checked against it: unchanged except top-3, now 69 % of new systems (was 67 %).

## Phase 0 — Setup
- [x] Mark: private repo + invite Cala; push starter kit
- [x] Cala: clone, copy data into data/raw, Python env, CSVs load
- [x] Mark: web/ Next.js + Tailwind + shadcn + Framer Motion on Vercel
  - Sat 19:40: production live on Vercel (project "web", auto-deploys from main); URL in env/.status only
- [ ] Both: confirm docs/api.md v0

## Phase 1 — Data and expert designs (Cala + Mark pair)
- [x] Profile every column of both installers (fill rate, values, outliers) → docs/data-notes.md
- [x] Expert design per project: PV kWp, battery kWh, wallbox, heat pump, inverter kW; all variants kept
- [x] Extra features: roof type, scaffolding, brand, installer, date, retrofit flags
- [x] Edge cases decided and written down
- [x] Per-installer catalogue of real sizes
- [x] engine/artifacts/expert_designs.parquet + 20 random projects spot-checked by hand

## Phase 2 — Engine and evaluation (Cala)
- [x] docs/engine-spec.md in plain English
- [x] Baselines (kWp ≈ kWh/1000; median by consumption band)
- [x] Chained model PV → battery → wallbox, installer-aware, snapped to catalogue
- [x] Similar-homes lookup → ranges + 5 nearest real projects
- [x] Locks: recompute around fixed components
- [x] Physics check + heat pump rules
- [x] Evaluation: held-out + installer A→B; variant-range hit rate; vs baselines
  - done on INTERIM labels (engine/interim_labels.py); rerun `python -m engine.train` once expert_designs.parquet lands
- [x] Error analysis by segment/installer (engine/RESULTS.md; /eval `segments`, `by_installer`, `by_band` #107; deck charts)
- [x] /validate
- [x] FastAPI deployed on Railway, matches docs/api.md
  - redeployed on 8 Nov with #100 and #107 (see status above)
  - engine/api.py runs locally and matches api.md (+ optional additions, see engine/README.md); not deployed yet
  - Sun 00:15 (orchestrator): production uses the fixed Railway URL (#28 closed); live /eval matches RESULTS.md 'shipped' column
    (battery mix #39); EV → wallbox + PV bump and roof cap verified on the live engine. /eval lacks P10–P90 coverage → issue #43

## Phase 3 — Product (Mark)
- [x] Design system + mockups (Claude chat) → tokens into web/
- [x] Planner screen (inputs → design cards → locks/overrides) (PR #12, incl. 'Solar already on the roof?')
- [x] Refine box + streamed explanation (PR #13: Claude agent with tools; engine computes all sizes)
- [x] Reality-check screen (ours vs expert + /eval charts) (PR #23: held-out demo cases + random from locked test set, verdicts with engine tolerances, /eval tiles, A→B transfer)
- [x] Supabase: saved_designs, overrides, homeowner share link (PR #12, #21; calls private: PR #20 migration 20261107_calls_private.sql)
- [x] Live on the real engine, deployed
  - Sun 00:15: prod on Railway engine (~90 ms health), passcode gate closed (planner API 401 without login), typed 4,500 kWh →
    9.0–9.45 kWp + 9.2 kWh. Open: ElevenLabs env vars + redeploy, then HQ test call

## Phase 4 — Stretch
- [x] Homeowner view (variants only, savings/payback/autarky in plain words) (PR #21: /offer/[token], allowed variants checked server-side, House3D, Listen to your offer)
- [x] Interactive 3D house `<House3D>` (web/src/components/house3d): panels from kWp, battery/inverter/wallbox/heat pump, energy flows, presets, tooltips, still-image fallback
  - mounted in the planner and /offer/[token] (PR #21)
- [x] Live-call big screen /live (PR #18): server-polled calls, facts checklist, live draft; scripted "Play demo call" sends the draft to the inbox
- [x] Hero build Sun night (Mark's picks): Planner A (#68, card ↔ house), Reality A (#72, two houses; #98 "One past home"), house v2 props (#70), labels never overlap (#85), real street from Google 3D tiles behind `?tiles=1` (#78), sun map (#83), Inside diorama (#95), panel editing (#99), `?static=1` / `?tiles=0` fallbacks (#78)
- [x] Voice: `update_facts` writes each answer live (#73, #76, #80, #106), Listen drives the house's day (#86), cached demo clip (#88, #91), plain spoken text (#101)
- [x] ElevenLabs "Explain my offer" voice + voice agent calling /design (backend: web/voice — create_design tool, post-call webhook, /api/solar, /api/voice/explain; audio off until the voice is confirmed)
- [x] Validation, shown on the cards instead of a separate screen (#61: a locked component says "Set by planner · Unusual" with the check message; /validate)
- [ ] Confidence calibration, A→B findings for the deck, fix worst 3 edge cases
  - calibration done (P10–P90 holds the expert's PV for 79–81 % of new systems, #46); A→B in /eval and on /reality; edge cases: not tracked as a list

## Phase 5 — Pitch and submission
- [ ] Business case · deck · metric charts · README · backup video · rehearse ×2 · submit by 13:30
  - [x] metric charts (docs/deck/charts.py) · [x] README (root + engine, PR #60: reproducible from the data-v1 release) · [x] pitch facts re-checked for leakage (answered mode = what-if, see engine/RESULTS.md)
  - [ ] deck (Mark, from docs/pitch-facts.md) · [ ] backup video (v1 recorded overnight on a local build of main + #89 + #103: `.status/backup/backup-v1.mp4`, never committed; v2 after the morning deploy) · [ ] judges invited to the repo + submission channel (ask organisers 08:00) · [ ] rehearse ×2 · [ ] freeze 11:00 · [ ] submit 13:30 Munich
  - metric charts done (docs/deck/charts.py, PR #40/#41) · deck: HQ chat in Claude Slides · pitch-facts, demo runbook, README: e-spare (docs/pitch)

## Decisions
- Sun 12:40 · Engine: hybrid model (#127: decisions from the first full design, sizes from every offer option) merged and deployed to production; deck, README, pitch-facts, submission, runbook updated to its numbers (2.93 vs 3.85 all homes; 2.45 vs 2.64 new systems; coverage 82 %; top-3 66 %; hero case 11.7 kWp).
- Sun 04:40 · Engine: physics plausibility flags are calibrated on expert practice (PV yield/consumption info > 2.5, warn > 4.0, error > 5.5; battery warn > 2.0 kWh/kWp) and a PV warning is downgraded when similar homes show the size is typical; small homes keep the expert-style 6-7 kWp + battery (#66). `/project?answered=true` = what-if with the planner's answer (#47). PV/battery alternatives = one smaller + one larger size with shares.
- Sun 03:00 · Deck charts follow docs/pitch-facts.md: accuracy charts use the mode WITHOUT the existing-PV answer, except new full systems (fair); chart 3 is the only answered chart and is titled what-if; new chart 5 = add-on sales without the answer
- Sun 03:00 · /reality two-houses cases (engine/demo_set.py --reality → demo_reality.json on data-v1): held-out typical PV+battery, EV+wallbox, battery retrofit; a case qualifies only if the held-out model AND /project's design are close (same components, PV ±1 kWp, battery ±2.5 kWh)
- Sun 00:05 · Vercel stays on Hobby: PRs touching web/ are merged by botmark5; engine-only merges by Cala are skipped on Vercel (#35)
- Sat 23:45 · Web: Google Solar roof (max kWp, azimuth, pitch) fills home.roof_* once per design with an address; planner can edit or remove; /reality headline = new full systems when /eval reports that slice, add-ons separate
- Sat 20:30 · Web: engine called only from server routes (key never in the browser); offline estimate after 4 s (design) or on any engine error, 15 s cooldown, "Offline estimate" badge
- Sat 20:30 · Web: refine agent = claude-sonnet-5-5 tool loop; a lock is accepted only at a value the planner wrote or the engine offered (alternatives, range ends, heat pump option); all sizes from run_design
- Sat 20:30 · Web: calls are server-only (names/addresses/transcripts); /live polls GET /api/calls every 2 s; realtime only on designs
- Sat 20:30 · Web: held-out ids for /reality read server-side from the gitignored engine/artifacts (or HELDOUT_PROJECT_IDS env); never committed
- Sat 20:15 · PV snaps to the installer's standard packages (sold >= 10x, within 1 kWp) else 450 W modules; battery cut-off learned out-of-fold (CV on training only)
- Sat 19:25 · Demo set = 5 HELD-OUT projects (locked test_ids.json) picked by fixed rules in engine/demo_set.py: typical PV+battery (closest to median), EV+wallbox, gas home with an expert heat pump (only 1 held out), battery retrofit, widest PV spread across full-design variants; output engine/artifacts/demo_projects.json (not committed, shared via data-v1)
- Sat 19:20 · 3D house is procedural three.js (Blender not installed); session B mounts `<House3D>`; roof from home.tilt_deg/orientation_deg, overridable by Google Solar via the `roof` prop
- Sat 19:15 · Orchestrator session coordinates the 4 Claude Code sessions via .status/ (local); merges green PRs, keeps this file honest
- Sat 20:10 · Engine trains on engine/labels expert_designs.parquet with its cleaned home columns (default 4,500 kWh kept WITH its flag; < 1,500 kWh invalid)
- Sat 20:10 · Test set locked in engine/artifacts/test_ids.json (grouped by customer, seed 42); all tuning by CV on the training part
- Sat 20:10 · Claims only against the BEST baseline per metric (kWh/1000, band median, installer kWp/MWh); results reported for all projects, full designs, real consumption
- Sat 19:40 · Offer type is its own decision (new PV / battery retrofit / wallbox only / other); optional planner input 'Is there already PV on the roof?' (biggest single error source)
- Sat 19:00 · Heat pump is a customer OPTION (offered for gas/oil homes, not included by default); /design returns the full design with and without it so the customer can choose by budget/needs
- Sat 18:40 · Model trains on interim labels (engine/interim_labels.py) until engine/labels lands; swap is automatic
- Sat 18:40 · PV size model: Huber loss + monotonic constraints (more demand / EV never shrinks PV); PV snapped to 450 W modules
- Sat 18:40 · New projects use an offer date capped at the 90th percentile of training dates (last month is an unusual retrofit batch)
- Sat 18:40 · Claude: Haiku 5.5 for /refine (structured output), Sonnet 5.5 for /explain (streamed, server-side refusal fallback); keyword/template fallback without key
- Sat 18:30 · Expert labels v1 (engine/labels): primary = lowest full new-system option; default 4,500 kWh = consumption unknown;
  A panels at 450 W; battery from the (shifted) numeric column; retrofits kept with offer_type, main model on new_system only.
  Rules: docs/labels-rules.md · schema: docs/data-notes.md
- Sat 18:00 · Physics = hourly synthetic year with seeded sunny/cloudy days, calibrated to HTW-Berlin rule-of-thumb ranges (not official BDEW tables)
- Sat 18:00 · Variant-range hit = inside [min, max] of the project's options ± tolerance (PV ± 1 kWp, battery ± 1 catalogue step); strict number reported too
- Sat 18:00 · Label contract proposed in docs/data-notes.md (one row per project × option, is_primary flag); evaluate.py joins inputs from data/raw
- Sat 16:00 · Data questions answered by our own assumptions (docs/data-notes.md); only business questions to Reonic
- Sat 15:45 · Build in Claude Code (Next.js), not Lovable · design system + mockups in Claude chat first
- Sat 15:15 · Keep all raw fields; expert-design table is derived on top
