# Engine

Python engine: expert labels → chained design model + physics → evaluation → FastAPI for the website.
The engine decides every size. Claude only turns planner text into input changes and writes explanations.

## Setup and run (Windows; on macOS/Linux use `.venv/bin/python`)
```
python -m venv .venv
.venv\Scripts\python -m pip install -r engine/requirements.txt
.venv\Scripts\python -m pytest engine/tests -q                # ~390 tests, no data or API key needed
```
The Reonic data and everything derived from it are **not in this repository** (`data/raw/`, `engine/artifacts/` are
git-ignored). This public copy contains no project, customer or option ids, and the two installers are called
`installer_a` and `installer_b`. With access to the Reonic hackathon data, put each installer's CSVs in
`data/raw/installer_a/` (the installer whose offers list panel counts only) and `data/raw/installer_b/`, then:
```
.venv/bin/python -m engine.labels      # expert_designs.parquet + catalogue.json from data/raw/<installer>/*.csv
.venv/bin/python -m engine.train       # draws a fresh customer-grouped test split, evaluates, trains -> engine/artifacts/
.venv/bin/uvicorn engine.api:app --reload --port 8000     # API; try it at http://localhost:8000/docs
```
- The installer id the API expects is the folder name (`installer_a` / `installer_b`); the web app defaults to `installer_a`.
- The metrics in this README and `RESULTS.md` come from the team's locked split (315 held-out projects); a fresh split gives
  slightly different numbers.
- Three tests check single known projects; they read `exNN` -> project-id prefix from a local `data/example_ids.json`
  and skip without it.
- `python -m engine.ablation` / `python -m engine.error_analysis` regenerate `RESULTS.md` tables.

Claude (optional): put `ANTHROPIC_API_KEY=...` in `engine/.env` (gitignored). Without a key, `/refine` uses a
keyword parser and `/explain` a template, so the demo always works. `GET /health` shows `"claude": true/false`.
The first Claude structured-output call takes ~25 s (schema compilation); the engine warms it up at start-up, later calls take ~2 s.

If `engine/artifacts/design_model.joblib` is missing, the API trains a model on first start (~30 s).

## Files
| file | what |
|---|---|
| `interim_labels.py` | TEMPORARY expert designs parsed from offer line items, in the label contract (docs/data-notes.md). Replaced automatically by Mark's `artifacts/expert_designs.parquet` as soon as it exists |
| `features.py` | home inputs → model features (same code for training and prediction), incl. EV + heat pump demand |
| `model.py` | `DesignModel`: chain heat pump rule → PV → battery → wallbox, locks, catalogue snapping, ranges, confidence, SHAP reasons, similar homes, validation |
| `physics.py` | hourly synthetic year: yield, self-consumption, autarky, heat pump rule, economics, sanity flags |
| `evaluate.py` | model-agnostic evaluation: held-out by project, installer transfer, baselines, variant hit rate |
| `train.py` | runs the evaluation, then trains the shipped model on all projects |
| `llm.py` | Claude Haiku 5.5 (`/refine`, structured output) and Claude Sonnet 5.5 (`/explain`, streamed, server-side refusal fallback) + no-key fallbacks |
| `api.py` | FastAPI: `/design`, `/validate`, `/refine`, `/explain`, `/eval`, `/project/{id}`, `/installers`, `/health` |
| `config/economics.toml` | price assumptions (all placeholders) |

## How a design is made
0. **Offer type:** no new PV → battery retrofit / wallbox only / other (classifier); the optional answer
   "Is there already PV on the roof?" is the strongest input for this.
1. **Heat pump = customer option:** if the home heats with gas/oil and the installer sells heat pumps, a heat pump is
   OFFERED (heat demand / 2,450 h, snapped to a size the installer sold: 5.5 / 7.5 / 8 / 10.5 / 12.5 kW) but not included by default; the customer chooses based
   on budget and needs. `/design` returns `options.heatpump` with the full design **with and without** it (PV/battery
   re-sized, extra investment, extra yearly savings, lifetime benefit, autarky). Choose it with `locks.heatpump_kw = kw`
   (or `/refine` "the customer wants a heat pump"). Never offered if a heat pump already exists.
2. **Total demand (physics):** household + EV (km/100 × 18 kWh) + new heat pump (heat / SCOP 3.5).
3. **PV:** yes/no classifier (cut-off learned out-of-fold by kWp cost); size from a Huber regressor with monotonic constraints (more demand or an EV never shrinks the PV); P10–P90 range; snapped to the installer's standard package (exact kWp sold ≥ 10 times, if within 1 kWp; e.g. 6.3 / 10.8 / 13.5 kWp) or else to whole 450 W modules.
4. **Battery:** yes/no + size class, both seeing the planned PV; probabilities restricted to the installer's catalogue. The yes/no cut-off for new systems is learned out-of-fold (~96 % of new systems get one, so it is low).
5. **Wallbox:** small classifier on EV features (most wallbox buyers have no EV recorded).
6. **Locks:** any component the planner fixes is kept, and the later steps adapt to it.
7. **Reasons:** per-decision SHAP contributions (LightGBM `pred_contrib`) turned into sentences.
8. **Alternatives:** next to the PV and the battery size, one smaller and one larger size the installer sells, chosen by a size classifier (the most likely size below and above the proposal, with its share). The expert's PV is within 1.5 kWp of one of the 3 PV options in 70 % of held-out homes (single proposal: 40-45 %).
9. **Plausibility flags** (`physics.flags`, `/validate`): thresholds calibrated on what the experts actually sold (PV yield / consumption p75 = 2.5, p96 = 4.0, p99 = 5.5; battery p98 = 2.0 kWh per kWp), plus the percentile among the 40 most similar past homes. Small homes are sized like the experts size them (homes under 2,000 kWh got a median 6 kWp and a battery in 100 % of cases), so such a design is explained ("most of the yield is fed in"), not called implausible.

## Results (locked test set: 315 projects never used for training or tuning, split by customer; labels: engine/labels (expert_designs.parquet))
Every claim is against the BEST of three baselines for that metric: kWh/1000, median per installer x consumption band, and the installer's own kWp-per-MWh ratio (~2).

**All projects** (model without the existing-PV answer):
| metric | model | best baseline | which baseline |
|---|---|---|---|
| PV kWp MAE, all projects (unwanted PV counts) | **2.93** | 3.85 | band median |
| PV kWp MAE, where both have PV (size only) | **2.48** | 2.64 | band median |
| PV within ± 1.5 kWp | 40 % | **43 %** | band median |
| PV inside the expert's variant range ± 1 kWp | **42 %** | 30 % | band median |
| battery kWh MAE, where both have one | **2.45** | 2.71 | band median |
| battery within one catalogue step | **56 %** | 51 % | band median |
| PV yes/no accuracy | **88 %** | 82 % | installer's most common choice (all baselines) |
| battery yes/no accuracy | 88 % | **90 %** | installer's most common choice (all baselines) |
| wallbox yes/no accuracy | 72 % | **73 %** | installer's most common choice (all baselines) |

**Full new-system designs** (253 projects; the planner knows it is a new system, so the model gets the answer "no PV on the roof yet"):
| metric | model (answered) | best baseline | which baseline |
|---|---|---|---|
| PV kWp MAE, all projects (unwanted PV counts) | **2.50** | 2.62 | band median |
| PV kWp MAE, where both have PV (size only) | **2.50** | 2.62 | band median |
| PV within ± 1.5 kWp | **45 %** | 43 % | band median |
| PV inside the expert's variant range ± 1 kWp | **38 %** | 37 % | band median |
| battery kWh MAE, where both have one | **2.61** | 2.64 | installer's most common battery size |
| battery within one catalogue step | **53 %** | 46 % | band median |
| PV yes/no accuracy | 100 % | 100 % | installer's most common choice (all baselines) |
| battery yes/no accuracy | 95 % | 95 % | installer's most common choice (all baselines) |
| wallbox yes/no accuracy | **73 %** | 72 % | installer's most common choice (all baselines) |

**Full designs with real consumption** (205 projects, no 4,500 kWh default):
| metric | model (answered) | best baseline | which baseline |
|---|---|---|---|
| PV kWp MAE, all projects (unwanted PV counts) | **2.38** | 2.49 | band median |
| PV kWp MAE, where both have PV (size only) | **2.38** | 2.49 | band median |
| PV within ± 1.5 kWp | 44 % | 44 % | band median |
| PV inside the expert's variant range ± 1 kWp | 37 % | **39 %** | band median |
| battery kWh MAE, where both have one | **2.55** | 2.55 | installer's most common battery size |
| battery within one catalogue step | **54 %** | 47 % | installer's most common battery size |
| PV yes/no accuracy | 100 % | 100 % | installer's most common choice (all baselines) |
| battery yes/no accuracy | 96 % | 96 % | installer's most common choice (all baselines) |
| wallbox yes/no accuracy | **74 %** | 73 % | installer's most common choice (all baselines) |

Installer transfer (train on one installer, test on the other), PV kWp MAE where both have PV, model vs band median: installer_b->installer_a: 2.95 vs 3.03; installer_a->installer_b: 2.82 vs 3.12.

## The one question that matters most: "Is there already PV on the roof?"
About 12 % of projects are battery-only add-ons to an existing PV system, but the data records existing PV for only
5 % of them, so the model must guess "new system or retrofit". The engine therefore takes an optional answer
(`home.has_existing_pv`: true / false / null, or `existing_pv_kwp`, 0 = none) and learns both modes (every training
project is used once answered, once unanswered). Offer types: new PV system / battery retrofit / wallbox only / other.

| same 315 locked held-out projects | not answered | planner answers | band median |
|---|---|---|---|
| PV kWp MAE, all projects | 2.93 | **2.15** | 3.85 |
| PV yes/no accuracy | 88 % | **97 %** | 82 % |
| battery yes/no accuracy | 88 % | **95 %** | 90 % |
| offer type correct | 83 % | **95 %** | – |

**Read the "planner answers" column as a what-if, not as a measured accuracy.** In the test set the answer is
*derived from the expert offer itself* (battery-only offer = "PV already there", new system = "no PV yet"); a real planner
would know this from the site visit, but here it leaks the label. The column shows what the question is worth if answered
correctly. Our headline claims use the **not answered** column (and, for new full systems, the segment tables above, where
the answer is the same for every project and therefore carries no information about sizes).

## Known limitations (be honest in the pitch)
- **Labels are interim** (my parser) until engine/labels lands; PV for installer A is panel count × an assumed 450 W.
- **PV size is barely predictable beyond consumption bands** (CV: 2.60 vs 2.69 kWp). The data has no roof size/orientation, which probably drives the expert choice.
- **PV size is scored three ways.** Over ALL projects (an unwanted PV system counts as an error) the model wins clearly. Scored only on projects where the expert installed PV, it loses to the band median: wrong "no PV" answers (battery-only retrofits are hard to tell apart) cost a whole system there, while the baseline says "PV" for almost everyone and is never penalised for retrofits. Size alone (both have PV) the model wins. The yes/no cut-off is learned out-of-fold on training data by kWp cost (currently 0.6). Ratio (kWp/MWh) and residual (vs kWh/1000) targets were tested and were not better (CV MAE 2.63-2.69 vs 2.60 kWp).
- **Wallbox ≈ coin flip** without EV information. **Heat pump** is offered (not chosen) for gas/oil homes; experts added one in 11 of 24 cases.
- **A new PV system always gets a battery.** The learned cut-off is 0 because 96 % of new systems in the data have one; "no battery"
  only comes from the planner (lock), a wallbox-only order or the retrofit path.
- **Minimum input = installer + yearly consumption** (gives roughly the band-median baseline). Blanking one input at a time on the
  locked test set: price, the "default 4,500 kWh" flag and the offer date each move PV yes/no by 3–5 points; EV, heating and load
  profile by < 1 point; removing the consumption costs 0.9 kWp of PV MAE. The answer to "Is there already PV on the roof?" is worth
  the most (PV yes/no 88 → 97 %).
- **Which offer option is "the expert design":** none is marked. Reonic confirmed on 8 Nov (Niklas): the export has no signed flag,
  option numbers only count up (a gap is a deleted option), neither the lowest nor the highest number is reliably the final design,
  and every option is a real planner's design for that home. Since then **every option of a project is a training row for the sizes**
  (`evaluate.build_train_table`, exact duplicates dropped: 1,536 rows from the 1,272 training projects) while the yes/no decisions
  (new PV, offer type, battery, wallbox) still learn from the project's first full design (`DesignModel(primary_decisions=True)`:
  a project with a retrofit and a new-system option must not teach both answers for one home). The evaluation reports, next to the
  error against the lowest-numbered option, the error against the **nearest option** (`*_nearest_option` metrics). On the locked test
  set: PV size MAE 2.48 → 2.45 kWp, battery within one step 54 → 56 %, P10–P90 coverage 80 → 82 %, every yes/no number unchanged
  (add-ons "no new PV" stays 77 %); top-3 within ±1.5 kWp 69 → 66 % is the one number that drops (engine/RESULTS.md, "All offer
  options"). Using the highest instead of the lowest option as the evaluation row changes 142 of 1,587 labels and moves PV MAE by
  ≤ 0.02 kWp.
- **Consumption below 1,500 kWh is rejected** (HTTP 422): the data has 21 placeholder entries at 0–1 kWh and nothing can be sized from them.
- **Time trend:** new projects use a date capped at the 90th percentile of training dates (~Mar 2026), because the last month is an unusual batch of battery-only retrofits.
- **Economics use placeholder prices.**

## API additions vs docs/api.md v0 (all optional, nothing removed)
`economics` block; `options.heatpump` (with/without comparison); `heatpump.option`; `physics.flags/assumptions/load_kwh/...`; `battery.alternatives`; `installer`, `has_existing_pv` and
`offer_date`/`orientation_deg`/`tilt_deg`/`existing_wallbox` as optional request fields; `/installers`, `/health`.
`/refine` returns `{changes, summary, parsed_by, home, locks, design}`.

## Deploy
The engine needs the Reonic data (or at least the trained artifacts), which are **never on GitHub**.
So a host that builds straight from the GitHub repo will not work out of the box. Options:
1. **Docker image built locally, pushed to a PRIVATE registry/host** (Fly.io, Railway, Render with a private image):
   `docker build -f engine/Dockerfile -t reonic-engine .` from the repo root. The image contains data/ and the model;
   set `ANTHROPIC_API_KEY` and `ENGINE_CORS_ORIGINS=https://<web>.vercel.app` as host secrets.
2. **Demo from this laptop through a tunnel** (`cloudflared tunnel --url http://localhost:8000`): no data leaves the
   machine, but the laptop must stay on.
Then set `NEXT_PUBLIC_ENGINE_URL` in the web app (Vercel) to the engine URL.

**Access key:** when the engine is reachable from outside, start it with `ENGINE_API_KEY=<random>`; every request
(except `/health`) must then send `X-Engine-Key: <key>`. In the web app, call the engine from a Next.js server route
(`app/api/.../route.ts`) and keep the key in a server-side env var (`ENGINE_API_KEY`, no `NEXT_PUBLIC_` prefix),
so the browser never sees it.
