# Engine results (aggregate only; regenerate with `python -m engine.ablation` and `python -m engine.error_analysis`)

Headline (Mark's request): **new full systems**, planner answered 'Solar already on the roof?'. Add-on sales (battery retrofits, PV extensions, wallbox-only) are reported separately in engine/README.md (segment add_ons).

## How to read "answered" (audit, 8 Nov, issue #50)

In the evaluation the answer to 'Solar already on the roof?' is **derived from the expert offer** (`evaluate.planner_answer`:
battery-only offer = yes, new system = no, wallbox-only/other = unknown). It is therefore an **oracle what-if**, not a measured input:
- On the **new full systems** segment the answer is "no" for every project, so it carries no information about sizes: the size metrics
  of that segment (PV 2.50 vs 2.62 kWp, battery 2.61 vs 2.64 kWh, within one step 54 vs 46 %) are fair and may be claimed.
  Its PV/battery yes/no numbers (100 % / 95 %) equal the baseline and are not an achievement.
- Over **all 315 projects** or on **add-on sales**, the answered yes/no numbers (PV yes/no 97 %, add-ons "no new PV" 87 %, battery yes/no
  95–97 %) and the answered all-project MAE (2.19 kWp) **mostly restate the label**. Do not claim them as accuracy. State them, if at all,
  as "what the question would be worth if the planner answers it correctly" (README table).
- The honest headline over all projects is the **not answered** column: PV MAE all projects 2.94 vs 3.77 kWp, PV yes/no 88 vs 82 %,
  PV size 2.48 vs 2.64 kWp, battery size 2.45 vs 2.71 kWh, battery within one step 54 vs 51 %; and the model loses on
  PV within ±1.5 kWp (40 vs 43 %), battery yes/no (88 vs 90 %) and wallbox (72 vs 73 %).

## Three strongest findings (for the deck)

1. **The decision that matters is new system vs. add-on, not the kWp.** Over all 315 held-out projects the chained model cuts the
   whole-project PV error from 3.77 to 2.94 kWp (−22 %) and gets PV yes/no right in 88 % vs 82 %, because it recognises battery
   retrofits from the planner's inputs (default consumption, date, price). Pure size error improves only slightly (2.48 vs 2.64 kWp).
2. **One input is worth more than the model: yearly consumption.** Blanking inputs one at a time on the locked test set
   (`experiments`, AUDIT.md): installer + consumption alone already reaches the band-median baseline; removing consumption costs
   0.9 kWp of PV MAE; price, the "default 4,500 kWh" flag and the offer date move PV yes/no by 3–5 points each; EV, heating and
   household profile by < 1 point. Asking "Is there already PV on the roof?" would be worth the most (PV yes/no 88 → 97 %, oracle).
3. **The labels are robust and the ranges are calibrated.** Choosing the highest instead of the lowest offer option changes 142 of 1,587
   expert labels but moves PV MAE by ≤ 0.02 kWp and battery MAE by ≤ 0.16 kWh; the conformal P10–P90 PV range contains the expert's size in
   79–81 % of new full systems (target 80 %); two trainings give identical predictions (fixed seeds).

## All offer options as training rows (Reonic's answer, 8 Nov)

Darius asked Reonic which option of a multi-option project the customer signed. Niklas (Reonic): no signed flag in the export, no
reliable proxy (option numbers only count up; a gap is a deleted option), and **every option is a valid planner's design**. The engine
had been training on one row per project (lowest option number). Four variants on the locked test set (315 projects, 61 with 2+
options, 1,272 training projects = 1,536 option rows), scored **both ways**: against the first option (the primary row, as before)
and against the **nearest option** of the project (the honest view once no option is "the" signed one).

- **A current** (deployed until 8 Nov): one row per project, the first full design.
- **B all options everywhere**: every option is a training row for everything.
- **C hybrid (shipped)**: yes/no decisions (new PV, offer type, battery, wallbox, cut-offs) learn from the first full design only;
  sizes, ranges, packages and alternatives learn from every option. A project with a retrofit *and* a new-system option otherwise
  teaches "new PV" and "no new PV" for the same home, which is what cost B five points on add-ons.
- **R best rule**: band-median baseline.

| all projects, not answered | A current | B all options | **C hybrid** | R best rule |
|---|---|---|---|---|
| PV kWp MAE, all projects | 2.94 | 2.91 | **2.93** | 3.77 |
| PV kWp MAE, size only | 2.48 | 2.43 | **2.45** | 2.64 |
| PV within ±1.5 kWp | 40 % | 41 % | **40 %** | 43 % |
| PV in expert variants ±1 kWp | 42 % | 43 % | **43 %** | 30 % |
| battery kWh MAE, size only | 2.45 | 2.44 | **2.42** | 2.71 |
| battery within 1 step | 54 % | 56 % | **56 %** | 51 % |
| PV yes/no | 87.6 % | 87.3 % | **87.6 %** | 81.6 % |
| battery yes/no | 87.6 % | 88.9 % | **87.6 %** | 89.8 % |
| wallbox yes/no | 71.7 % | 71.4 % | **71.7 %** | 72.7 % |
| offer type | 83.2 % | 83.5 % | **83.2 %** | – |
| P10–P90 contains expert PV | 80 % | 82 % | **82 %** | – |
| top-3 within ±1.5 kWp | 70 % | 67 % | **67 %** | – |
| nearest option: PV kWp MAE, size only | 2.45 | 2.39 | **2.41** | 2.60 |
| nearest option: PV within ±1.5 kWp | 45 % | 47 % | **47 %** | 45 % |
| nearest option: battery kWh MAE, size only | 2.41 | 2.39 | **2.36** | 2.61 |
| nearest option: battery within 1 step | 58 % | 59 % | **59 %** | 53 % |

| add-ons (62 held-out retrofits / wallbox-only), not answered | A current | B all options | **C hybrid** | R best rule |
|---|---|---|---|---|
| "no new PV" (PV yes/no) | 77 % | 73 % | **77 %** | 6 % |
| battery kWh MAE, size only | 0.69 | 0.75 | **0.64** | 1.21 |
| battery within 1 step | 74 % | 74 % | **74 %** | 77 % |

| full designs (253), answered | A current | B all options | **C hybrid** | R best rule |
|---|---|---|---|---|
| PV kWp MAE, size only | 2.49 | 2.47 | **2.47** | 2.62 |
| PV within ±1.5 kWp | 45 % | 45 % | **45 %** | 43 % |
| battery kWh MAE, size only | 2.64 | 2.60 | **2.60** | 2.97 |
| battery within 1 step | 54 % | 55 % | **55 %** | 46 % |
| P10–P90 contains expert PV | 79 % | 81 % | **81 %** | – |
| nearest option: PV kWp MAE, size only | 2.46 | 2.43 | **2.43** | 2.57 |
| nearest option: battery within 1 step | 55 % | 56 % | **56 %** | 49 % |

Reading: C keeps every yes/no number of A (the decisions are learned from the same rows) and takes the size gains of B. The one
number that moves down is top-3 within ±1.5 kWp (70 → 67 %, 6 of 230 homes): the proposal moves with the new size model and the two
alternatives next to it do not fully follow; training the alternatives on the first option only does not bring it back (68 %), so
the consistent choice (alternatives from every option, all of them real sizes) is kept. The nearest-option rows are the honest size
metrics now; both views are in `eval_results.json` (`*_nearest_option`). Exact duplicate options are dropped so a copied option does not
count twice.

## Before/after per improvement (locked test set)

315 held-out projects (engine/artifacts/test_ids.json, grouped by customer), truth = engine/labels.

## all projects

| metric | A  before #1 (no offer type, 450 W modules) | B  + #1 offer type + existing-PV input | C  + #3 installer packages | D  + #5 calibration | E  + battery kWh/kWp mix (shipped) | (PV linear blend, not shipped) | #4 before: interim labels + raw inputs | best baseline: band median |
|---|---|---|---|---|---|---|---|---|
| PV kWp MAE, all projects | 2.99 | 2.93 | 2.94 | 2.94 | 2.94 | 2.93 | 2.90 | 3.77 |
| PV kWp MAE, size only | 2.47 | 2.47 | 2.48 | 2.48 | 2.48 | 2.46 | 2.49 | 2.64 |
| PV within ±1.5 kWp | 39 % | 40 % | 40 % | 40 % | 40 % | 40 % | 39 % | 43 % |
| PV exact match | 5 % | 5 % | 9 % | 9 % | 9 % | 7 % | 10 % | 9 % |
| PV in expert variants ±1 kWp | 41 % | 42 % | 42 % | 42 % | 42 % | 41 % | 43 % | 30 % |
| battery kWh MAE, size only | 2.53 | 2.52 | 2.52 | 2.50 | 2.45 | 2.46 | 2.39 | 2.71 |
| battery within 1 step | 55 % | 51 % | 50 % | 51 % | 54 % | 54 % | 53 % | 51 % |
| PV yes/no | 87 % | 88 % | 88 % | 88 % | 88 % | 88 % | 88 % | 82 % |
| battery yes/no | 90 % | 87 % | 87 % | 88 % | 88 % | 88 % | 87 % | 90 % |
| offer type | 83 % | 82 % | 82 % | 83 % | 83 % | 83 % | 82 % | 82 % |
| P10–P90 contains expert PV (target 80 %) | 75 % | 75 % | 75 % | 80 % | 80 % | 80 % | 81 % | 9 % |

## full designs (answered)

| metric | A  before #1 (no offer type, 450 W modules) | B  + #1 offer type + existing-PV input | C  + #3 installer packages | D  + #5 calibration | E  + battery kWh/kWp mix (shipped) | (PV linear blend, not shipped) | #4 before: interim labels + raw inputs | best baseline: band median |
|---|---|---|---|---|---|---|---|---|
| PV kWp MAE, all projects | 3.10 | 2.48 | 2.49 | 2.49 | 2.49 | 2.48 | 2.50 | 2.62 |
| PV kWp MAE, size only | 2.44 | 2.48 | 2.49 | 2.49 | 2.49 | 2.48 | 2.50 | 2.62 |
| PV within ±1.5 kWp | 40 % | 45 % | 45 % | 45 % | 45 % | 45 % | 44 % | 43 % |
| PV exact match | 5 % | 6 % | 9 % | 9 % | 9 % | 7 % | 10 % | 9 % |
| PV in expert variants ±1 kWp | 34 % | 38 % | 37 % | 37 % | 37 % | 36 % | 38 % | 37 % |
| battery kWh MAE, size only | 2.81 | 2.71 | 2.69 | 2.69 | 2.64 | 2.63 | 2.59 | 2.97 |
| battery within 1 step | 50 % | 48 % | 49 % | 49 % | 54 % | 53 % | 54 % | 46 % |
| PV yes/no | 90 % | 100 % | 100 % | 100 % | 100 % | 100 % | 100 % | 100 % |
| battery yes/no | 95 % | 95 % | 95 % | 95 % | 95 % | 95 % | 95 % | 95 % |
| offer type | 90 % | 100 % | 100 % | 100 % | 100 % | 100 % | 100 % | 100 % |
| P10–P90 contains expert PV (target 80 %) | 75 % | 74 % | 74 % | 79 % | 79 % | 79 % | 81 % | 9 % |

## full + real consumption (answered)

| metric | A  before #1 (no offer type, 450 W modules) | B  + #1 offer type + existing-PV input | C  + #3 installer packages | D  + #5 calibration | E  + battery kWh/kWp mix (shipped) | (PV linear blend, not shipped) | #4 before: interim labels + raw inputs | best baseline: band median |
|---|---|---|---|---|---|---|---|---|
| PV kWp MAE, all projects | 2.37 | 2.37 | 2.38 | 2.38 | 2.38 | 2.37 | 2.37 | 2.49 |
| PV kWp MAE, size only | 2.36 | 2.37 | 2.38 | 2.38 | 2.38 | 2.37 | 2.37 | 2.49 |
| PV within ±1.5 kWp | 43 % | 45 % | 44 % | 44 % | 44 % | 45 % | 43 % | 44 % |
| PV exact match | 4 % | 4 % | 7 % | 7 % | 7 % | 7 % | 9 % | 8 % |
| PV in expert variants ±1 kWp | 36 % | 36 % | 36 % | 36 % | 36 % | 35 % | 37 % | 39 % |
| battery kWh MAE, size only | 2.65 | 2.64 | 2.62 | 2.62 | 2.57 | 2.61 | 2.48 | 2.77 |
| battery within 1 step | 52 % | 50 % | 50 % | 50 % | 54 % | 53 % | 55 % | 45 % |
| PV yes/no | 100 % | 100 % | 100 % | 100 % | 100 % | 100 % | 100 % | 100 % |
| battery yes/no | 96 % | 96 % | 96 % | 96 % | 96 % | 96 % | 96 % | 96 % |
| offer type | 100 % | 100 % | 100 % | 100 % | 100 % | 100 % | 100 % | 100 % |
| P10–P90 contains expert PV (target 80 %) | 75 % | 75 % | 75 % | 80 % | 80 % | 80 % | 81 % | 8 % |


## Tested and not shipped (5-fold CV grouped by customer, training part only)
| idea | result | decision |
|---|---|---|
| PV size: Huber linear model / 50-50 blend with LightGBM | CV MAE 2.44 / 2.45 vs 2.50 kWp (within fold noise); locked test neutral, exact package matches 9 -> 7 % | not shipped (switch `blend=True`) |
| PV size: LightGBM L1 / sklearn HistGB / random forest / kNN (25 similar homes) | 2.52 / 2.52 / 2.54 / 2.83 kWp vs 2.50 | not better |
| roof type as an optional input | 2.51 vs 2.50 kWp | no gain |
| PV target kWp/MWh ratio or residual vs kWh/1000 | 2.63-2.69 vs 2.60 kWp; EV could shrink PV | not better |
| battery size: classifier + installer kWh/kWp rule (mean) | CV 2.35 -> 2.25 kWh, within one step 57 -> 61 %; locked test 49 -> 54 % | **shipped** |
| external data: PVGIS (EU JRC) yield per tilt x orientation + monthly split | physics only (never labels) | **shipped** (physics) |

### Round 2: deterministic, hybrid and tuned approaches for PV size (5-fold CV by customer, training part, new systems, n=1046)
| approach | PV MAE kWp | within ±1.5 kWp | note |
|---|---|---|---|
| current LightGBM (Huber + monotone) | 2.49 | 43 % | shipped |
| best of 14 random hyperparameter settings (4 leaves) | 2.47 | 44 % | −0.6 %, inside fold noise (±0.18) and selection bias: not changed |
| hybrid: LightGBM + physics optimiser kWp/autarky as inputs | 2.49 | 43 % | physics adds no information about expert choices |
| hybrid: mean of LightGBM and a power law | 2.48 | 43 % | same |
| power law per installer, kWp = a · MWh^b (fitted) | 2.56 | 42 % | deterministic; no better than the band median |
| per-installer LightGBM | 2.57 | 41 % | pooling both installers wins (little data each) |
| band median (best baseline) | 2.57 | 41 % | |
| economic optimum (20-yr net benefit, physics) x installer ratio | 2.77 | 39 % | experts do not size for maximum return |
| economic optimum, raw | 10.20 | 1 % | with feed-in pay, more PV always "pays": hits the grid limit |

### Round 2: battery size given the PV (5-fold CV, training part, new systems with a battery, n=1006)
| approach | battery MAE kWh | within one catalogue step |
|---|---|---|
| **classifier + installer kWh/kWp rule (mean)** | **2.25** | **61 %** (shipped) |
| median by installer x PV band | 2.27 | 56 % |
| classifier alone | 2.35 | 57 % |
| classifier + kWh/kWp + kWh/MWh rules (mean of 3) | 2.38 | 58 % |
| installer kWh/kWp rule | 2.48 | 53 % |
| published rule: 1 kWh per kWp (HTW Berlin / installers' rule of thumb) | 2.54 | 54 % |
| installer mode | 2.72 | 44 % |
| installer kWh per MWh consumption | 3.62 | 44 % |
| published rule: 1 kWh per 1,000 kWh consumption | 4.46 | 21 % |

### Round 3: PV as a choice among real sizes, all variants, top-3 alternatives (CV, training part, n=1046)
| approach | PV MAE kWp | single within ±1.5 | top-3 within ±1.5 | top-3 exact |
|---|---|---|---|---|
| regression + snap (shipped point), top-3 = nearest sizes | 2.49 | 43 % | 54 % | 21 % |
| classifier over the installer's real sizes (expected value + snap) | 2.58 | 42 % | 69 % | 25 % |
| classifier over sizes (argmax) | 3.04 | 37 % | 72 % | 25 % |
| train on all offer variants (weight 1/n) | 2.49 | 43 % | – | – |
| **point = regression, 2 alternatives = size classifier (shipped)** | **2.49** | **43 %** | **71 %** | **24 %** |

Locked test set (shipped): the expert's PV is within 1.5 kWp of one of our 3 options in **67–70 %** of projects (single
proposal: 40–45 %), exactly among them in ~22 %; the proposal's MAE is unchanged. API: `design.pv.alternatives`;
/eval: `pv_top3_within_1.5_pct`, `pv_top3_exact_pct`.

**Conclusion.** PV size has reached what these inputs can explain: every learner, rule, hybrid and tuning lands within
2.47–2.57 kWp, and the remaining error is information the data does not contain (roof size and shape, customer budget
and wishes). The biggest lever is new inputs, not new algorithms: the optional roof capacity from Google Solar (now an
input, used as a cap) and the existing-PV question (PV yes/no 90 → 100 %). Installers here size batteries by PV size,
not by consumption. External registries (Marktstammdatenregister) hold installed sizes without household data, so they
could only serve as a plausibility check, not as training labels.

## Physics flags calibrated on expert practice (8 Nov, issue #66; training part of the locked split, new systems, n = 1,046)

What the experts actually sold, so that the plausibility flags measure "unusual for these installers", not a textbook rule:

| quantity | p50 | p75 | p90 | p95 | p97.5 | p99 | flag thresholds now |
|---|---|---|---|---|---|---|---|
| PV yield / yearly consumption (950 kWh per kWp, incl. EV) | 1.82 | 2.47 | 3.18 | 3.67 | 4.38 | 5.42 | info > 2.5 · warn > 4.0 · error > 5.5 (was warn > 2, error > 3: flagged 44 % / 13 % of expert designs) |
| battery kWh per kWp of PV | 0.97 | – | – | 1.7 | – | 2.22 | warn > 2.0 (was 1.5) |
| battery usable kWh / daily consumption (days) | 0.61 | 0.82 | 1.09 | 1.31 | – | 1.84 | info > 1.5 (unchanged) |

By consumption band (new systems): homes under 2,000 kWh (n = 13) got a median 6.0 kWp (p10 5.85) and a battery in 100 % of
cases (median 6 kWh); 2,000–2,500 kWh (n = 39): 7.65 kWp, battery 97 %; 2,500–3,000 kWh (n = 63): 7.2 kWp, battery 90 %.
Only 40 of 1,046 new systems have no battery (38 at installer A; median consumption 4,250 kWh, no EV): "no battery" in a new
system is a 4 % expert choice without a visible pattern in the inputs, which is why the learned cut-off is "always a battery"
and the engine proposes none only for add-on orders or on the planner's lock.

## Error analysis (locked test set, shipped model)

## Mode: not answered

### by installer

| installer   |   n |   PV yes/no % |   PV MAE (both) |   PV bias (both) |   battery yes/no % |   battery MAE (both) |   P10-P90 cover % |
|:------------|----:|--------------:|----------------:|-----------------:|-------------------:|---------------------:|------------------:|
| installer_b    |  67 |         94.03 |            2.68 |            -1.03 |              98.51 |                 2.67 |             82.54 |
| installer_a    | 248 |         85.89 |            2.4  |            -0.51 |              84.68 |                 2.38 |             79.04 |

### by true_group

| true_group       |   n |   PV yes/no % |   PV MAE (both) |   PV bias (both) |   battery yes/no % |   battery MAE (both) |   P10-P90 cover % |
|:-----------------|----:|--------------:|----------------:|-----------------:|-------------------:|---------------------:|------------------:|
| battery_retrofit |  41 |         82.93 |          nan    |           nan    |              87.8  |                 0.71 |               nan |
| other            |   5 |         80    |          nan    |           nan    |              20    |               nan    |               nan |
| pv               | 257 |         89.49 |            2.48 |            -0.65 |              91.44 |                 2.72 |                80 |
| wallbox_only     |  12 |         66.67 |          nan    |           nan    |              33.33 |               nan    |               nan |

### by band

| band   |   n |   PV yes/no % |   PV MAE (both) |   PV bias (both) |   battery yes/no % |   battery MAE (both) |   P10-P90 cover % |
|:-------|----:|--------------:|----------------:|-----------------:|-------------------:|---------------------:|------------------:|
| <3k    |  54 |         98.15 |            2.25 |            -0.91 |              98.15 |                 2.11 |             84.91 |
| 3-4.5k | 166 |         80.72 |            2.22 |            -0.44 |              80.72 |                 2.2  |             80.9  |
| 4.5-6k |  36 |         97.22 |            2.52 |             0.03 |             100    |                 2    |             71.43 |
| 6-9k   |  39 |         97.44 |            2.61 |            -1.13 |              92.31 |                 3.14 |             81.08 |
| >9k    |  15 |        100    |            3.4  |            -0.26 |             100    |                 5.29 |             80    |

### by demand_is_default

| demand_is_default   |   n |   PV yes/no % |   PV MAE (both) |   PV bias (both) |   battery yes/no % |   battery MAE (both) |   P10-P90 cover % |
|:--------------------|----:|--------------:|----------------:|-----------------:|-------------------:|---------------------:|------------------:|
| False               | 217 |         96.31 |            2.47 |            -0.7  |              94.01 |                 2.54 |             79.71 |
| True                |  98 |         68.37 |            2.54 |            -0.19 |              73.47 |                 2.19 |             82.61 |

### by pv_source

| pv_source     |   n |   PV yes/no % |   PV MAE (both) |   PV bias (both) |   battery yes/no % |   battery MAE (both) |   P10-P90 cover % |
|:--------------|----:|--------------:|----------------:|-----------------:|-------------------:|---------------------:|------------------:|
| module_lines  |   9 |        100    |            3.49 |            -0.01 |             100    |                 2.65 |             55.56 |
| none          |  58 |         79.31 |          nan    |           nan    |              70.69 |                 0.71 |            nan    |
| package_name  |  41 |         95.12 |            1.94 |             0.16 |              97.56 |                 2.03 |             94.87 |
| roof_mounting |  24 |        100    |            3.38 |            -2.17 |              95.83 |                 3.82 |             75    |
| substructure  | 183 |         86.34 |            2.42 |            -0.66 |              89.07 |                 2.74 |             78.48 |

### offer type: true (rows) vs predicted (columns)

| true_group       |   battery_retrofit |   other |   pv |   wallbox_only |
|:-----------------|-------------------:|--------:|-----:|---------------:|
| battery_retrofit |                 29 |       0 |    7 |              5 |
| other            |                  3 |       0 |    1 |              1 |
| pv               |                 16 |       1 |  230 |             10 |
| wallbox_only     |                  4 |       1 |    4 |              3 |


## Mode: planner answered 'PV already on the roof?'

### by installer

| installer   |   n |   PV yes/no % |   PV MAE (both) |   PV bias (both) |   battery yes/no % |   battery MAE (both) |   P10-P90 cover % |
|:------------|----:|--------------:|----------------:|-----------------:|-------------------:|---------------------:|------------------:|
| installer_b    |  67 |         95.52 |            2.68 |            -1.03 |              98.51 |                 2.65 |             82.54 |
| installer_a    | 248 |         96.77 |            2.46 |            -0.53 |              89.52 |                 2.28 |             77.6  |

### by true_group

| true_group       |   n |   PV yes/no % |   PV MAE (both) |   PV bias (both) |   battery yes/no % |   battery MAE (both) |   P10-P90 cover % |
|:-----------------|----:|--------------:|----------------:|-----------------:|-------------------:|---------------------:|------------------:|
| battery_retrofit |  41 |         90.24 |          nan    |           nan    |             100    |                 0.86 |            nan    |
| other            |   5 |         80    |          nan    |           nan    |              20    |               nan    |            nan    |
| pv               | 257 |         99.22 |            2.52 |            -0.65 |              94.16 |                 2.62 |             78.82 |
| wallbox_only     |  12 |         66.67 |          nan    |           nan    |              33.33 |               nan    |            nan    |

### by band

| band   |   n |   PV yes/no % |   PV MAE (both) |   PV bias (both) |   battery yes/no % |   battery MAE (both) |   P10-P90 cover % |
|:-------|----:|--------------:|----------------:|-----------------:|-------------------:|---------------------:|------------------:|
| <3k    |  54 |         98.15 |            2.25 |            -0.91 |              98.15 |                 2.11 |             84.91 |
| 3-4.5k | 166 |         96.39 |            2.36 |            -0.49 |              87.95 |                 2.08 |             78.07 |
| 4.5-6k |  36 |         97.22 |            2.52 |             0.03 |             100    |                 2    |             71.43 |
| 6-9k   |  39 |         97.44 |            2.61 |            -1.13 |              92.31 |                 3.14 |             81.08 |
| >9k    |  15 |        100    |            3.4  |            -0.26 |             100    |                 5.29 |             80    |

### by demand_is_default

| demand_is_default   |   n |   PV yes/no % |   PV MAE (both) |   PV bias (both) |   battery yes/no % |   battery MAE (both) |   P10-P90 cover % |
|:--------------------|----:|--------------:|----------------:|-----------------:|-------------------:|---------------------:|------------------:|
| False               | 217 |         97.24 |            2.47 |            -0.7  |              94.01 |                 2.52 |             79.71 |
| True                |  98 |         94.9  |            2.71 |            -0.43 |              85.71 |                 1.96 |             75    |

### by pv_source

| pv_source     |   n |   PV yes/no % |   PV MAE (both) |   PV bias (both) |   battery yes/no % |   battery MAE (both) |   P10-P90 cover % |
|:--------------|----:|--------------:|----------------:|-----------------:|-------------------:|---------------------:|------------------:|
| module_lines  |   9 |        100    |            3.49 |            -0.01 |             100    |                 2.65 |             55.56 |
| none          |  58 |         84.48 |          nan    |           nan    |              79.31 |                 0.86 |            nan    |
| package_name  |  41 |        100    |            2.04 |            -0.04 |              95.12 |                 1.98 |             92.68 |
| roof_mounting |  24 |        100    |            3.38 |            -2.17 |              95.83 |                 3.81 |             75    |
| substructure  | 183 |         98.91 |            2.46 |            -0.62 |              93.44 |                 2.6  |             77.35 |

### offer type: true (rows) vs predicted (columns)

| true_group       |   battery_retrofit |   other |   pv |   wallbox_only |
|:-----------------|-------------------:|--------:|-----:|---------------:|
| battery_retrofit |                 37 |       0 |    4 |              0 |
| other            |                  3 |       0 |    1 |              1 |
| pv               |                  2 |       0 |  255 |              0 |
| wallbox_only     |                  4 |       1 |    4 |              3 |
