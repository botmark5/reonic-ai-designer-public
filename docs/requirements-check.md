# Requirements check against the Reonic brief (updated 8 Nov 2026, 10:00 Munich time)

Every requirement of `docs/reonic-brief.pdf`, where it is met, and the evidence. Status: **done** = on main and on
production; **human** = needs Mark; **not done**. Earlier version: 04:40 (all PRs since then are merged).

## Minimum result (brief p. 2 and p. 7)
| requirement | status | evidence |
|---|---|---|
| Complete design for a project: PV, battery, heat pump **as appropriate**, with a short explanation of why | done | `POST /design` (engine/api.py); chain in `engine/model.py` `propose`; heat pump as a customer option with both variants (`options.heatpump`); "no new PV" and "no battery" are real outputs for add-on orders and planner locks; reasons per component; planner cards on `/` |
| "No battery" / "no heat pump" possible (p. 4 "As appropriate matters") | done, documented | retrofit / wallbox-only / other offer types, locks `battery_kwh = 0`, heat pump never included by default. For new systems the engine always proposes a battery because 96 % of experts do; the 4 % no-battery expert choice has no visible pattern (`engine/RESULTS.md`, "Physics flags calibrated on expert practice") |
| Measure how close designs come to the expert designs on unseen projects | done | 315 held-out homes split by customer (`engine/artifacts/test_ids.json`, never committed); `GET /eval` incl. `by_band`, segments, transfer; `engine/RESULTS.md`; `/reality`; three rules-of-thumb baselines |
| Planner changes an input or component and gets an updated design | done | locks (any component), refine box in plain words (Claude → structured input changes → engine), roof cap, panel editor; verified on production (runbook table) |

## Stretch goals (p. 7)
| requirement | status | evidence |
|---|---|---|
| Analysis of where and why designs deviate from the experts | done | `engine/error_analysis.py`, `RESULTS.md` error analysis; `/eval by_band`; `/reality` "Where we differ from the experts" and "Solar size error by yearly consumption" |
| Alternatives and confidence for every recommendation | done | confidence per component; calibrated P10–P90 PV range; `pv.alternatives` and `battery.alternatives` = one smaller and one larger catalogue size with shares (#82, live); heat pump with/without; top-3 metric 70 % on screen |
| Validation view for planners | done | every card: percentile among 40 similar homes + physics flags calibrated on expert practice (#82, #118), also for planner-locked values ("Set by planner · Unusual"); `POST /validate` |
| View in which homeowners explore their offer, on the same engine | done | `/offer/<token>`: 3D house through a day, variants the installer allows (battery size, heat pump, car charger, checked server-side), plain-language explanation, "Listen to your offer" (ElevenLabs) |

## Ideas to explore (p. 6), where we have an answer
| question | answer | where |
|---|---|---|
| What do expert decisions have in common? Thresholds, bundles? | ~2 kWp per MWh; battery sized by PV (≈1 kWh/kWp), not by consumption; 96 % of new systems get a battery; small homes get 6 kWp + battery; experts do not size for maximum return | `RESULTS.md` round 2, calibration table; deck slide 8 |
| Combine learning with physical/economic reasoning | physics layer (PVGIS yield, hourly year) for yield/autarky/economics and plausibility flags; the economic optimum was tested as a predictor and lost (2.77 vs 2.49 kWp) | `engine/physics.py`, `RESULTS.md` |
| Minimum input, missing information | installer + yearly consumption reach the band-median rule; defaults + `physics.assumptions` list every assumption; the "left at 4,500 kWh" flag is modelled and shown as its own band | `engine/README.md` Known limitations (input ablation), `/eval by_band` not_entered |
| Communicate confidence, alternatives, trade-offs | confidence, range, alternatives, with/without heat pump economics, "Offline estimate" badge | planner cards, `/design` |
| What does refinement feel like | plain words (refine box), locks, chips for alternatives, ± one panel, roof cap input | planner |
| Validation view "battery unusually large" | "Larger than 99 % of similar homes (x–y kWh is usual)" on the card | `/validate`, `system-card.tsx` |
| What can a homeowner change | variants allowed by the installer only; the home's data stays fixed | `/offer`, `web/src/lib/offer.ts` |

## Demo moment (p. 7) and submission (p. 8)
| item | status | note |
|---|---|---|
| Home described → complete system + why → refined ("EV next year") → checked against reality on many projects | done | `docs/demo-runbook.md` click path; engine redeployed 09:15 Munich with #82 (flags, alternatives, what-if), `by_band`, `/heldout` |
| Working demo end to end | done | Vercel + Railway; `/api/engine/health` reports the engine; passcode gate |
| Short recording as a fallback | done | backup v3 (6:53) recorded on a local production build of main against the production engine, following the final script; in `~/Downloads/REVIEW-ME/`, never committed |
| Code as a GitHub link + README on setup, approach, known limitations | done, human | root `README.md`, `engine/README.md`, `docs/user-guide.md`; repo is private: judges must be invited |
| Short pitch deck: problem, solution, evaluation, value | draft | `docs/pitch-deck.md` plan + the Claude Slides draft linked there; Mark to export and finalise |
| Data used only for the hackathon, never shared | done | `data/raw/` and `engine/artifacts/` gitignored, never committed; raw project ids removed from hover tooltips (#119) |

## Open items (owner: Mark unless noted)
1. ~~Production engine behind main~~: redeployed at 09:55 Munich with #118 and verified live (heat pump option text, locked PV range with a roof cap, no-PV battery text, /validate context). Production = main.
2. Invite the judges to the repository; ask the organisers for the submission channel.
3. Export the deck to PDF right before submitting (no freeze); rehearse twice with `docs/demo-runbook.md`.
4. Record the backup video on production (runbook shot list).
5. PR #92 (Vercel ignore rule) and this docs PR are the only open PRs; no open issues.
