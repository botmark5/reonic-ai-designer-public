# Reonic AI Designer — agent guide

## What we are building (thinc! Hack Munich, Reonic case, 7–8 Nov 2026)
An AI system that turns a few facts about a home into a complete energy-system design — PV size, battery yes/no + size,
wallbox yes/no, heat pump yes/no + size — deciding the way an experienced installer's planner would.
Full brief: `docs/reonic-brief.pdf` (local only). Plan and status: `docs/PLAN.md`.

## How we are judged (Reonic) — optimise for all four
1. Technical depth: how well designs reproduce expert decisions, measured convincingly on UNSEEN projects.
2. User fit: planner (speed, control, can override anything, never a black box) and homeowner (plain language, explore variants).
3. Business impact: time per offer, design quality, win rate.
4. Execution + demo: works end to end, 5-minute story: home entered → full system + why → "buying an EV next year" → design adapts → compared with the real expert design + metrics across many projects.
Minimum: complete design with explanation · accuracy vs experts on held-out projects · planner changes an input/component and gets an updated design.
Stretch: deviation analysis · alternatives + confidence · validation view ("battery unusually large") · homeowner view.
Also competing for NAP (cleanest UX, original idea, best pitch) and ElevenLabs (best project using ElevenLabs).

## Hard rules
- The ENGINE decides sizes (statistics/ML + physics + installer catalogue). An LLM never picks component sizes.
  Claude is only used to (a) turn planner text into structured input changes, (b) turn engine facts into plain-language explanations.
- Decisions are coupled: PV → battery → wallbox are predicted as a chain, not independently. "No battery" / "no heat pump" must be possible outputs.
- Outputs snap to sizes the installer actually sells (per-installer catalogue).
- Raw data lives in `data/raw/` and is NEVER committed (Reonic: do not share the data). Repo is private.
- Every data assumption goes in `docs/data-notes.md`; every decision in the Decisions section of `docs/PLAN.md`.

## Repo layout and ownership
- `engine/` — Python (Cala): data pipeline → expert designs → model → evaluation → FastAPI. Entry: `engine/api.py`.
- `web/` — Next.js + Tailwind + shadcn/ui + Framer Motion (Mark). Talks to the engine only via `docs/api.md`.
- `docs/` — PLAN.md (status), api.md (contract, change only with both owners agreeing), data-notes.md, engine-spec.md, prompts/.
- Branches: `main` always runs; work on `engine/<topic>` or `web/<topic>`, merge by PR. Stay inside your folder.

## Working style for agents
- Plan first, then code. Show results (tables, numbers) before moving on. Prefer small scripts + saved artifacts in `engine/artifacts/`.
- When you finish a task in docs/PLAN.md, tick it (`- [x]`) and commit with the change.
- Python: pandas, scikit-learn, lightgbm. Fixed random seeds. Group train/test splits by project_id; also report installer A → B transfer.
