# Pitch facts

Every number the pitch, deck or README may use, with where it comes from and how to say it.
Checked on 2026-11-08 at 00:20 against the live engine's `GET /eval` (P10–P90 coverage at 00:55); re-checked at 02:20 after PR #60 (metrics unchanged) and re-classified after the audit (`engine/RESULTS.md`, "How to read answered"). Re-checked on production at 02:50 after PR #61: every `/eval` number below is unchanged and matches what `/reality` shows.

**How to read this**
- **Safe** means say it as written. **Caveat** means say it only together with the caveat in the same row. **Don't** means leave it out.
- **"Answered"** means the planner answered "Solar already on the roof?". **In the evaluation that answer is derived from the expert's own offer** (battery-only offer = yes, new system = no), so an answered yes/no or all-homes number mostly restates the label. Such numbers are a **what-if** ("what the question is worth when answered correctly"), never an accuracy, and live in section 3 only. Two answered slices are fair and may be quoted: new full systems (every home gets the same answer, so it carries no information about sizes) and the size metrics derived from them.
- **(on screen)** marks what `/reality` shows (headline = new full systems; add-on sales and all homes without the answer; the answered numbers only in the what-if card).
- **"One past home" (the two houses on `/reality`, #98) is not held-out.** It shows the shipped engine, which learned from all past projects including that home: "a picture of how it designs, not a test". Say "held-out" or "never saw" only for the tiles below the houses (2.42 vs 2.62 kWp, 77 % vs 6 %, coverage 79 %, top-3) and for the `ours_held_out` values in the data-v1 `demo_reality.json`.
- "Same as rule" is the wording /reality uses for a tie. Use it in the pitch too.
- Lower is better for errors (MAE = mean absolute error per home). Higher is better for percentages.

Sources:
- `/eval` means `GET /eval` on the live engine, the same JSON as `engine/artifacts/eval_results.json`. Paths below start at its root, and `dm` stands for `design_model`.
- `RESULTS.md` means `engine/RESULTS.md`. Its column E is the shipped model.
- `aggregates.json` means `docs/deck/out/aggregates.json`, written by `docs/deck/charts.py`. It is also on the data-v1 release.

## 1. How we measured
| fact | number | source | say it |
|---|---|---|---|
| Held-out test set, never trained on | 315 homes | `/eval` `protocol.n_test` | Safe as "never trained on". Model choices were made by cross-validation on the training part, but the locked set was re-scored after each shipped improvement (`engine/RESULTS.md` "Before/after per improvement"), so never say "never looked at" or "never used for tuning". |
| Split | grouped by customer (41 customers have 2 projects), stratified by installer, seed 42 | `/eval` `protocol` | Safe |
| Installers in the data | 2: A (248 test homes) and B (67 test homes) | `/eval` `by_installer` | Safe. Say "Installer A / B", never the ids. |
| Shipped model is trained on | 1,563 projects | live `GET /health` `trained_on_projects` | Safe |
| Expert designs parsed from offer line items | 1,994 offer options (1,637 + 357) from 1,593 projects | `docs/data-notes.md` inventory table (options); `docs/engine-spec.md` (projects) | Safe |
| Hand check of the parsed expert designs | 20 random projects checked by hand against their raw offer lines | `docs/PLAN.md` Phase 1; `engine/spotcheck.py` (PR #7) | Safe as "hand-checked". The result is not recorded, so don't claim "all correct". |
| Comparison | the **best** of 3 rules of thumb for each metric: kWh ÷ 1,000, installer median per consumption band, installer kWp per MWh | `/eval` `baselines` | Safe. Always say "best rule of thumb", not "a baseline". |
| Installer A's PV size rests on an assumed 450 W per panel | median design 9.0 kWp; 8.6 at 430 W, 9.5 at 475 W | `docs/engine-spec.md` §3 | Caveat: only if asked about label quality. |
| Which offer option is "the expert design" | none is marked. Reonic (Niklas, 8 Nov): no signed flag, no reliable proxy, gaps are deleted options, every option is a valid planner's design. Since 8 Nov the sizes learn from every option (exact duplicates dropped) while new-vs-add-on and the other yes/no decisions learn from the first full design; the evaluation also reports the error against the nearest option. Effect on the locked test set: PV size MAE 2.48 → 2.45 kWp, battery within one step 54 → 56 %, range coverage 80 → 82 %, yes/no numbers unchanged, top-3 70 → 67 %. Evaluation row stays the lowest option number (the highest instead changes 142 of 1,587 labels, PV error moves ≤ 0.02 kWp) | `engine/RESULTS.md` "All offer options"; `docs/data-notes.md` | Safe; quote Niklas's answer if asked. |

## 2. Headline: PV size
| fact | engine | best rule | source | say it |
|---|---|---|---|---|
| **All 315 homes, whole-project solar error** (an unwanted or missing system counts) **(on screen, what-if card left value)** | **2.93 kWp** | 3.85 (band median) | `/eval` `metrics.*.pv_kwp_mae_all_projects` | **Safe. 24 % lower (live /eval after the hybrid model; 3.77 / 22 % before). This is the headline number for "all homes".** |
| **New systems** (253 homes, planner says "new system") **(on screen)** | **2.45 kWp** | 2.64 (band median) | `/eval` `with_existing_pv_answer.segments.full_designs.{dm,baseline_band_median}.pv_kwp_mae_all_projects` (RESULTS.md shows 2.49: rounding of 2.4996) | Caveat: "on par with the best rule, slightly better". The 5 % gap is inside the cross-validation noise of ±0.18 kWp (RESULTS.md, round 2). Fair: the answer is the same for every home here. |
| New systems with real consumption (205 homes) | **2.33 kWp** | 2.51 (band median) | `/eval` `with_existing_pv_answer.segments.full_designs_known_consumption.*` | Caveat: same as above, within noise. |
| PV size where both chose PV, all homes | 2.45 kWp | 2.66 | `/eval` `metrics.*.pv_kwp_mae_when_both_pv` | Safe |
| PV yes/no right, all homes | 88 % | 82 % | `/eval` `metrics.*.has_pv_accuracy` | Safe: "recognises add-on sales from the planner's inputs". |
| PV within ±1.5 kWp, all homes | 40 % | 43 % | `/eval` `metrics.*.pv_kwp_within_1.5_pct` | Caveat: **below the rule**. Say it before a judge asks: "on exact size we are no better than the band median; the gains are the yes/no decisions and the ranges". |
| Exact PV package match | 9 % | 9 % | RESULTS.md, "PV exact match" | Don't |

### Alternative scoring: against the closest of the expert's options (Reonic, 8 Nov)
Reonic (Niklas, 8 Nov): the export has no "signed" flag, and every option is a valid planner's design. So scoring against the expert's *closest* option is a fair alternative to scoring against the first option. Same model, same 315 homes, same rules of thumb scored the same way.

| fact (all 315 homes) | engine | best rule | first-option number | source | say it |
|---|---|---|---|---|---|
| PV size where both chose PV, vs closest option | **2.41 kWp** | 2.61 (band median) | 2.45 vs 2.66 | `/eval` `metrics.*.pv_kwp_mae_nearest_option` | Caveat: say "scored against the closest of the expert's options". |
| PV within ±1.5 kWp, vs closest option | **47 %** | 45 % (band median, 44.96) | 40 vs 43 | same, `pv_kwp_within_1.5_nearest_option_pct` (47.19) | Caveat: "about level with the rule" once every option counts (not below it). |
| Battery within one size step, vs closest option | **59 %** | 53 % (band median) | 56 vs 51 | same, `battery_within_one_step_nearest_option_pct` (59.26 vs 53.17) | Caveat: alternative scoring, say it as such. |

Also on `/eval`: new systems (answered) PV 2.41 vs 2.58 kWp, within ±1.5 48 vs 45 %; whole-project PV error, all homes, 2.87 vs 3.79.
Don't: mix the two scorings in one sentence, or replace the first-option headline (2.93 vs 3.85, 2.45 vs 2.64) with these. Live on `/eval` (`*_nearest_option` metrics) since #127 shipped (8 Nov 12:40 Munich).

## 3. What-if: the planner answers "Solar already on the roof?" (never as accuracy)
In this test the answer is taken from the expert offer itself, so these rows show what the question is worth **if** answered correctly. Quote them only with the words "what-if" or "if the planner answers", never as "our accuracy". Why the question exists: the data records existing solar for only 5 % of the homes that got a battery-only add-on (`engine/README.md`).

| fact | without the answer | with the answer (what-if) | source |
|---|---|---|---|
| PV error, all 315 homes **(on screen, what-if card)** | 2.93 kWp | 2.15 kWp (−27 %) | `/eval` `metrics` vs `with_existing_pv_answer.metrics`, `dm.pv_kwp_mae_all_projects`; deck chart 3 (title it "what-if") |
| PV yes/no right, all homes **(on screen, what-if card)** | 88 % | 97 % | `dm.has_pv_accuracy` |
| Battery yes/no right, all homes **(on screen, what-if card)** | 88 % | 95 % | `dm.has_battery_accuracy` |
| Offer type right (new / battery retrofit / wallbox only / other) **(on screen, what-if card)** | 83 % | 95 % | `dm.offer_type_accuracy` |
| PV error, add-on sales (62 homes) | 2.18 kWp | 0.94 kWp | `segments.add_ons` |
| Inside the expert's variant range ±1 kWp, all homes | 42 % | 48 % | `dm.pv_variant_hit_tolerant_pct` |
| Battery size where both chose one, all homes | 2.42 kWh | 2.36 kWh | `dm.battery_kwh_mae_when_both_battery` |
| Wallbox yes/no, all homes | 72 % | 75 % | `dm.has_wallbox_accuracy` |

**Don't** quote "no new solar for 87 % of add-on homes (rules: 6 %)", "add-on battery yes/no 97 %", "add-on battery within one size 84 %" or "add-on PV in range 87 % vs 3 %": they are answered-mode add-on numbers and restate the label. The honest add-on numbers are in section 5.

## 4. Inside the expert's own options (variant range)
Expert range means the smallest to largest PV across the variants the expert offered, ±1 kWp. A single offer is its own range.

| fact | engine | best rule | source | say it |
|---|---|---|---|---|
| All 315 homes | **43 %** | 29 % | `/eval` `metrics.*.pv_variant_hit_tolerant_pct` | Caveat: add-on sales drive most of the gap (correctly saying "no new PV" counts as a hit there). |
| New systems **(on screen)** | 40 % | 36 % | `…with_existing_pv_answer.segments.full_designs.*.pv_variant_hit_tolerant_pct` | Safe as "slightly above the rule" (the screen badge says Better). |

## 5. Battery, wallbox, heat pump, add-on sales (all without the answer unless marked)
| fact | engine | best rule | source | say it |
|---|---|---|---|---|
| Battery size, both chose a battery, all homes | **2.42 kWh** | 2.71 | `/eval` `metrics.*.battery_kwh_mae_when_both_battery` | Safe |
| Battery within one catalogue size, all homes | **56 %** | 51 % | `/eval` `metrics.*.battery_within_one_step_pct` | Safe |
| Battery size, new systems | 2.59 kWh | 2.64 (installer's most common size) | `…with_existing_pv_answer.segments.full_designs.*` | Caveat: same as rule. RESULTS.md compares with the band median (2.97), but the strongest rule here is the installer's most common size. |
| Battery within one catalogue size, new systems **(on screen)** | **57 %** | 46 % | `…segments.full_designs.*.battery_within_one_step_pct` | Safe |
| Battery yes/no, new systems **(on screen)** | 95 % | 95 % | `…segments.full_designs.*.has_battery_accuracy` | Caveat: same as rule; a new system always gets a battery (96 % of them do in the data). Over all homes without the answer it is 88 % vs 90 %, below the rule. |
| Wallbox yes/no, new systems **(on screen)** | 73 % | 72 % | `…segments.full_designs.*.has_wallbox_accuracy` | Safe as "about the same as the rule". Without EV information it is near a coin flip; most wallbox buyers have no EV recorded. All homes: 72 % vs 73 %, below the rule. |
| Add-on sales (62 homes): proposes **no new solar** where none was sold **(on screen)** | **77 %** | 6 % | `/eval` `segments.add_ons.*.has_pv_accuracy` | Safe, with "62 homes" and "without being told there is solar on the roof": rules of thumb propose new solar for almost every home. |
| Add-on sales: battery yes/no **(on screen)** | 69 % | 69 % | `segments.add_ons.*.has_battery_accuracy` | Caveat: same as rule. |
| Add-on sales: battery within one catalogue size **(on screen)** | 74 % | 77 % (band median) | `segments.add_ons.*.battery_within_one_step_pct` | Caveat: below the rule, 62 homes. |
| Heat pump yes/no | 99 % | 99 % | `/eval` `dm.has_heatpump_accuracy` | Don't: almost no home in the data gets one. |
| Heat pump in the product | offered as a customer option for gas and oil homes, never chosen by the engine. Size = heat demand ÷ 2,450 full-load hours, snapped to the sizes the installer sold (5.5 / 7.5 / 8 / 10.5 / 12.5 kW). | `engine/README.md` §How a design is made | Safe |
| Experts added a heat pump when it was a candidate | 11 of 24 homes | `engine/README.md` §Known limitations | Safe |

## 6. Trust: ranges, installers, consumption, inputs
| fact | number | source | say it |
|---|---|---|---|
| Expert PV falls inside the engine's P10–P90 range, new full systems (253 homes) | **82 %** (target 80 %): 82 % answered **(on screen, "Calibrated")**, 82 % not answered, 80 % with real consumption | `/eval` `with_existing_pv_answer.segments.full_designs.dm.pv_interval_coverage_pct`, `segments.full_designs.dm.pv_interval_coverage_pct`, `segments.full_designs_known_consumption.dm.pv_interval_coverage_pct` | Safe as "82 % on new full systems (target 80 %)". Never quote a coverage for add-on sales: they get no new PV, so there is nothing to cover. |
| Expert PV within 1.5 kWp of one of the engine's 3 options (proposal + smaller + larger), new full systems **(on screen)** | **66 %** (66.0 on screen = answered new systems, since the hybrid model went to production on 8 Nov 12:40; 67.5 without the answer; 68.8 before); all homes without the answer 70 % (69.6, unchanged) | `/eval` `with_existing_pv_answer.segments.full_designs.dm.pv_top3_within_1.5_pct`; `metrics.dm.pv_top3_within_1.5_pct` | Safe as "66 % of new systems" (the same slice as the other tiles). Quote 70 % only if asked, and then say "all homes, without the solar answer". There is no rule-of-thumb comparison for top-3. |
| Trained on installer B only, tested on installer A (PV size where both chose PV) | 2.95 vs 3.03 kWp best rule | `/eval` `transfer["installer_b->installer_a"].*.pv_kwp_mae_when_both_pv` | Caveat: small margin, tested on all of A's projects. |
| Trained on A only, tested on B | 2.82 vs 3.12 kWp | `/eval` `transfer["installer_a->installer_b"].*` | Same caveat |
| Engine beats the best rule in held-out and transfer tests per installer | 4 of 4 | `aggregates.json` `pv_mae_installer_transfer`; deck chart 2b | Safe |
| PV size error by yearly consumption (both chose PV, without the answer) | 2.1–2.6 kWp up to 9 MWh; 3.4 kWp above 9 MWh (15 homes). **Pre-hybrid training**: `/eval` `by_band` is still fitted one row per project (engine/eval_bands.py) | `aggregates.json` `bands`; deck chart 2a | Safe |
| Homes left at the 4,500 kWh default ("consumption not entered") | 98 of 315; PV size error 2.54 kWp (without the answer, pre-hybrid by_band; 2.71 was the answered mode) | `aggregates.json` `bands[unknown]`; deck chart 2a | Safe |
| Minimum input | installer + yearly consumption already reach the band-median rule; removing the consumption costs 0.9 kWp of PV error; price, the "left at default" flag and the offer date each move PV yes/no by 3–5 points; EV, heating, household profile < 1 point | `engine/README.md` Known limitations (audit input ablation on the locked test set) | Safe: "one number does most of the work; the solar question would do the rest". |

## 7. What the data can and cannot explain
| fact | number | source | say it |
|---|---|---|---|
| Every learner, hybrid and tuned variant tried for PV size lands in a narrow band | 2.47–2.57 kWp (5-fold CV by customer, new systems, 1,046 homes); kNN 2.83 and the economic optimum 2.77 did worse | RESULTS.md, round 2 | Safe: "we hit the ceiling of what these inputs explain; the rest is roof and customer wishes". |
| Experts do not size for maximum return | sizing for the economic optimum gives 2.77 kWp error vs 2.49 for the engine | RESULTS.md, round 2 | Safe |
| Installers size the battery by PV size, not by consumption | engine rule 2.25 kWh, "1 kWh per kWp" 2.54, "1 kWh per 1,000 kWh" 4.46 (CV) | RESULTS.md, round 2, battery table | Safe |
| Installers size PV at about 2 kWp per MWh | median 1.9 (A) and 2.2 (B) kWp per MWh; "kWh ÷ 1,000" undersizes by about half | `docs/engine-spec.md` §3 | Safe |
| Small homes get a full system on purpose, like the experts | experts' median for 1,500–2,500 kWh new systems with consumption entered (primary option): **7.2 kWp**, P10 5.0, P90 10.8 (n = 109); 50 of them are at exactly 2,500 kWh, and without them the median is 6.75 kWp (n = 59). The engine gives a 1,600 kWh home (planner defaults) 7.2 kWp + 5 kWh with the hybrid engine (the experts' median; 7.65 + 9.2 before), inside the experts' P10–P90. | `engine/artifacts/expert_designs.parquet` (data-v1), checked by e-spare and a-labels; engine `/design` on Railway and on main, 2026-11-08 | Safe: "small homes get a full system, about 7–8 kWp + a battery, on purpose, like the experts (median 7.2 kWp)". |
| Biggest lever is new inputs, not algorithms | roof capacity from Google Solar (used as a cap), the existing-solar question | RESULTS.md, conclusion | Safe |

## 8. Business impact: what we can say (measured or in the brief), nothing invented
| fact | number | source | say it |
|---|---|---|---|
| The problem, in Reonic's words | planners "spend hours on every single design"; "the first credible offer often wins" | the challenge brief, p.3 and p.5 | Safe, quoted as the brief's statement, not as our measurement. |
| One full design from the engine | 0.27–0.64 s (two runs of 10 calls, laptop to the live engine; most of it is network: `/health` alone took 0.15–0.48 s on the same connections) | measured 2026-11-08 00:20 and 02:50 | Safe: "a reviewed draft in about half a second instead of a design from scratch". |
| Voice call to draft design on production | 207 ms engine time | d-voice smoke test, 2026-11-08 00:13 | Safe |
| **Measured: call to homeowner link** | **6 clicks, 29 s** from "Play demo call" to the homeowner link (median of 3 runs: 28.7–29.4 s), of which 24.5 s is the scripted call itself. After the call ends: draft in the planner's inbox in **0.34 s**, planner open with the design in 0.36 s, a plain-words change ("Customer wants no battery", Claude + engine) in **3.8 s** (3.4–4.0), saved and shared in under 0.1 s. **4.6 s** from the end of the call to a shared offer. The draft is on screen during the call, 12 s in, as soon as the yearly use is known. | Headless Chrome clicking the real UI, `next dev` on the laptop against the live Railway engine and live Claude, in-memory store instead of Supabase, 2026-11-08 03:05; script `time_flow.mjs` in e-spare's scratchpad (not in git) | Safe, with "machine time": the planner's own review time comes on top and is not measured. Compare only with the brief's words in the first row of this section ("hours on every single design"), never as "X % faster" or minutes saved. |
| Every size is traceable | reasons from the model's own feature attributions, a calibrated range, 5 similar past projects, installer catalogue sizes | `engine/model.py` propose; `/design` response | Safe: "the planner can justify every number to the homeowner" (brief: "fears a black box"). |
| Planner overrides are validated | a locked component is compared with the 40 most similar past homes and physics; "Larger than 99 % of similar homes" shown on the card | `/validate`; planner card | Safe: this is the brief's second use case, "design validation". |
| Consistency | same inputs → same design, deterministic (fixed seeds; two trainings give identical predictions) | `engine/tests/test_audit_regressions.py` | Safe: "junior planners design like the installer's own history". |
| Three use cases, one engine | planner draft, planner validation, homeowner offer (+ voice intake) | the product | Safe |
| Engine tests / web tests | 413 pytest collected on main 3a79b0d (a-labels; 13 need the data); 419 vitest in 43 files (main 5daaafc, 8 Nov, all passing). Re-count right before submitting. | `pytest`; `npm test` | Safe |
| Who decides sizes | the engine only. Claude turns planner text into input changes and writes explanations. | `CLAUDE.md`, `engine/README.md` | Safe |

## Don't say
- **"X % accurate"** without saying which metric and which comparison.
- **Any answered-mode yes/no or all-homes number as accuracy** (97 % PV yes/no, 2.15 kWp, 87 % add-on "no new solar", 97 % / 84 % add-on battery). Section 3 only, as a what-if.
- **Time saved per offer, or win-rate uplift.** Neither was measured. Every project in the data is a signed deal, so there are no lost offers to learn from. Say "a reviewed draft in seconds instead of a design from scratch" and leave the minutes to Reonic.
- **Payback years and savings as facts.** The economics use placeholder prices (`engine/config/economics.toml`).
- **"Beats the experts"** or **"matches the experts"** for new systems. Say "on par with the best rule of thumb, and it explains itself, takes the planner's changes and handles add-on sales".
- **P10–P90 coverage for add-on sales**, or any coverage other than new full systems.
- **"The engine never saw this home"** about the two houses on `/reality`. It did see it; only the numbers below the houses are held-out.
- **Project ids, installer ids, customer names, or any number from a single real project.** Reonic data stays private. On stage, reading the example case that `/reality` shows is fine; don't put single-project numbers on slides or in the submission text.
