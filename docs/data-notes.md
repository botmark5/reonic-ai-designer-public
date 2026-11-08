# Data notes and working assumptions

Data: `data/raw/<installer>/projects_status_quo.csv` (one row per project = the home before) and
`project_options_parts.csv` (offer line items per project and offer option = what the installer proposed).

| Folder | Projects | With parts | Options | Offer dates | Main brands |
|---|---|---|---|---|---|
| installer_a | 1,277 | 1,257 | 1,637 | 2024-06 → 2026-04 | Huawei, Flowmax, SAJ (+ SolarEdge, Enphase); PV modules almost never listed |
| installer_b | 342 | 336 | 357 | 2025-06 → 2026-04 | Voltara (+ Gridwell, Kestrel, Flowmax); "Complete Package … X kWp + Y kWh" bundles |

Verified on the data 2026-11-07 (profiling + `engine/labels.py`). Extraction rules: `docs/labels-rules.md`.

## Facts checked in the data
- Every project has `first_signed_at` → the data is **won offers only**. Which option was signed is not recorded.
  **Reonic's answer (Niklas, 8 Nov 2026, asked by Darius):** no signed flag in the export; no reliable proxy either, option numbers
  just count up as options are created (planners add variants or copy and keep editing), so neither the lowest nor the highest is
  reliably the main or final design; gaps are deleted options and mean nothing; treat every option as a valid planner's design
  (most projects have one option; multi-option projects are often near-identical).
- **Numeric columns in the parts file are shifted.** On BatteryStorage rows `inverter_power_kw` holds the battery capacity
  in Wh (filled on 100% of battery rows). On Inverter rows `battery_capacity_kwh` holds inverter power in W.
  `wb_charging_speed_kw`, `heatpump_nominal_power_kw`, `module_watt_peak` are in W.
- Status-quo units: `energy_demand_wh` Wh/yr, `energy_price_per_wh` €/Wh, `solar_size_kwp` **Wp**, `storage_size_kwh` **Wh**,
  `wallbox_charge_speed_kw` W, `heating_existing_heating_demand_wh` Wh.
- `energy_demand_wh` is exactly 4,500,000 (the Reonic default) in 410 / 69 projects → treated as **consumption unknown**
  (`consumption_known` False; 67% / 80% of projects with parts have a real value). 21 projects have 0–1 kWh → invalid.
- `has_storage` is mostly the battery being sold, entered by the planner: 9 of 11 have build year ≥ offer year or the offer
  sells exactly that size. Only 2 real existing batteries. `has_solar` is True in 18 projects (A only) and under-reports
  retrofits: 130 battery-only offers have `has_solar` False.
- `load_profile` is H0 in 92% (= household type unknown). `heating_existing_type` empty in 88% (= Unknown, not "no heating").
  House size, build year, inhabitants < 1% filled → optional planner inputs, not features.
- Option 1 is missing in 399 / 132 projects (numbers are not 1..n). 22% of A projects and 6% of B projects have 2+ options.
  Exact duplicate options in 64 / 4 projects. Variants differing only in battery size: 75 projects (A).
- 41 customers have two projects (A) → group train/test splits by customer as well as project.

## Labelling decisions (approved by Mark 2026-11-07; details and examples in docs/labels-rules.md)
- Primary label (the evaluation row) = lowest option_number among the project's full new-system designs (lowest overall if none).
  It is a representative row, not the signed option (none is marked, see above). **Training uses every option for the sizes** since
  8 Nov (`evaluate.build_train_table`, exact duplicates dropped; 1,536 rows from 1,272 training projects); the yes/no decisions
  (new PV / add-on, battery, wallbox) still learn from the first full design only (`is_primary`), see engine/RESULTS.md. All variants kept:
  per-project min/max PV and battery = the acceptable range for evaluation and the homeowner's choices; `pv_options` /
  `battery_options` = the distinct sizes, scored by the `*_nearest_option` metrics (error against the closest option).
- `offer_type`: new_system 1,624 · battery_retrofit 232 · wallbox_only 75 · no_components 25 · heatpump_only 21 · pv_extension 17
  options. Main model and evaluation use `is_full_design` (= new_system) and not `is_outlier`.
- PV kWp, in order: module lines (qty × planning W) → B package kWp → A per-panel count (Substructure qty) × 450 W →
  A "PV Complete Package N kW" → B Roof Mounting qty × 450 W → size band midpoint. A has no module wattage, so 450 W is
  assumed (`pv_wp_assumed`). Sensitivity on 923 primary A designs: median 8.6 / 9.0 / 9.5 kWp at 430 / 450 / 475 W.
- Battery kWh = Σ BatteryStorage column (Wh/1000 × qty), excluding the Flowmax AC coupler; name only when the column is empty;
  B package "+ Y kWh" only when no battery row (72 options). Lines beat packages (all 28 conflicts are planner changes).
- Wallbox = Wallbox row, a wallbox installation fee (kW unknown then), or - when neither exists - an "Other"-typed promo/product line
  (`Free .*Wallbox`, `Wallbox Promo`, name starting `EV Charger`; not Prep/Expenses/Cable/Meter/Power Boost/Subsidy Deadline;
  kW from the name, n = 1). Promo text next to a Wallbox row never adds a second wallbox. Heat pump kW from the product name (column is rounded).
- B "Substructure/Roof Mounting A-B kWp" bands are price tiers, not measurements: panel count × 450 W falls outside the
  line's own band in 33 of 209 options, both below and above (20 panels in a "15-20kWp" tier, 36 in "8.8-15kWp"). The count wins.
  One option names a module wattage only in a surcharge line ("Surcharge AIKO 475W", 24 panels) → kept at 450 W.
- Outliers (> 30 kWp or > 40 kWh): 2 options (99.9 kWp / 108 kWh commercial; 45 kWh battery-only). Also outliers: full designs
  below 1 kWp (`pv_implausible`, placeholder quantities); 6 options (4 of them primary rows): B 3, A 3.
- Among primary full designs: no battery in 5.6% (A) / 1.2% (B); wallbox in 26% / 22%; heat pump in 7 projects (A).
  New heat pumps: 31 options in 17 projects, all A → heat pump = rules + physics, not learned.
- No prices in the data → savings/payback use stated market assumptions (see PLAN business case).

## expert_designs.parquet schema
File: `engine/artifacts/expert_designs.parquet` (built by `engine/labels.py`, never committed: derived from Reonic data).
One row per project × offer option. Projects without any parts (20 + 6) are not in the file.
Units are fixed: power kW, PV kWp, energy kWh, price €/kWh. Missing numbers are NaN, never 0, unless stated.
Status: v1.1 schema (adds n_wallboxes, roof_mixed, pv_source size_band; is_primary prefers full designs), agreed 2026-11-07. Columns may be added; existing ones will not change meaning.

### Identity and variants
| column | type | unit | meaning |
|---|---|---|---|
| installer | str | | data folder id: `installer_a` or `installer_b` |
| project_id | str | | project (= one home); group train/test splits by this |
| customer_contact_id | str | | customer; 41 customers have 2 projects, so also group splits by this |
| option_id | str | | offer option id (1:1 with option_number) |
| option_number | int | | variant number as entered by the planner (1–19, gaps common) |
| is_primary | bool | | the training label row: lowest option_number among the project's full designs (is_full_design); lowest overall when the project has none. Exactly one per project (option 1 is missing in ~1/3 of projects) |
| n_options | int | | number of options in the project |
| is_duplicate_option | bool | | same line items and quantities as a lower-numbered option of the same project |
| offer_type | str | | `new_system` (new PV modules, with or without battery/wallbox/heat pump), `pv_extension` (PV added to an existing PV), `battery_retrofit` (battery without new PV, may include wallbox), `wallbox_only`, `heatpump_only`, `no_components` |
| is_full_design | bool | | `offer_type == "new_system"`; main model and evaluation use only these rows |
| pv_kwp_min, pv_kwp_max | float | kWp | range of pv_kwp over the project's options with the same is_full_design value |
| battery_kwh_min, battery_kwh_max | float | kWh | same range for battery_kwh (0 counts: "no battery" is a valid variant) |
| (note) | | | ranges include `pv_implausible` options of the same project: 1 project (B·ex27) has pv_kwp_min 0.9 next to a 7.2 kWp primary. Filter those options before computing your own range if you need it exact. |

### Expert design (the labels)
| column | type | unit | meaning |
|---|---|---|---|
| pv_kwp | float | kWp | new PV size; 0 when the option has no new PV |
| pv_panels | float | panels | number of new modules. A: Substructure qty (or module lines). B package rows (no module lines): kWp / 0.45 (+ named extras), i.e. the installer's own 450 W package math, not a count seen in the data. NaN when no panel count is known: no PV, or the size comes only from a A package name or a B size band (73 options with pv_kwp > 0) |
| pv_source | str | | `module_lines`, `package_name`, `substructure`, `roof_mounting`, `size_band` (only a kWp band like "6-8.8kWp" is known → midpoint), `none` |
| pv_wp_assumed | float | W | assumed W per panel when the data has no module wattage (450); NaN when wattage came from the data or a package name |
| battery | bool | | battery_kwh > 0 |
| battery_kwh | float | kWh | total new storage (main unit + extensions); 0 = no battery |
| battery_source | str | | `numeric_column`, `name`, `package_name`, `none` |
| wallbox | bool | | option contains a wallbox |
| wallbox_kw | float | kW | charging power (11 or 22); NaN when no wallbox or when a wallbox is installed without a wallbox product line |
| n_wallboxes | float | count | number of wallboxes; 0 when none |
| heatpump | bool | | option contains a heat pump |
| heatpump_kw | float | kW | nominal heat pump power from the product name; NaN when none |
| inverter_kw | float | kW | sum of inverter power when inverter lines exist; NaN otherwise (installer_a almost never lists inverters) |
| roof_type | str | | from substructure/DC-install names (`Beaver Tail Tile`, `Bitumen`, `Clay Tile`, `Concrete Tile`, `Facade`, `Flat`, `Metal`, `Slate`, `Unknown`); type with the most panels when several; `Unknown` when none |
| roof_mixed | bool | | panels on more than one roof type |
| has_scaffolding | bool | | scaffolding / site-safety line present |
| has_backup | bool | | emergency-power / backup box line present |
| brand | str | | main system brand (battery/inverter/wallbox brand, e.g. Huawei, Flowmax, Voltara); `Unknown` when none |
| n_line_items | int | | number of line items in the option |

### Home features (cleaned status quo, same for every option of a project)
| column | type | unit | meaning |
|---|---|---|---|
| offer_created_at | datetime | | offer date; falls back to first_signed_at when empty |
| annual_kwh_raw | float | kWh | yearly consumption as entered |
| annual_kwh | float | kWh | cleaned consumption: NaN when the entry is the 4,500 kWh default or invalid (< 1,500 kWh) |
| demand_is_default | bool | | entered value is exactly 4,500 kWh, the Reonic default (32% / 20% of projects) |
| demand_is_invalid | bool | | entered value < 1,500 kWh (21 projects at 0–1 kWh) |
| consumption_known | bool | | not default and not invalid; use this to report evaluation separately for homes with real consumption |
| price_eur_kwh | float | €/kWh | electricity price; one value entered in €/kWh is fixed, 0 → NaN |
| price_increase | float | fraction/yr | expected price growth (0.03 = 3%) |
| flex_tariff_eur_kwh | float | €/kWh | dynamic-tariff price; mostly NaN |
| load_profile | str | | H0 (default, = household type unknown), FamilyOfFour, HomeOfficeOnePerson, … |
| has_ev | bool | | home has or plans an EV |
| ev_km_year | float | km | yearly EV distance; NaN when unknown |
| existing_pv_kwp | float | kWp | PV already on the roof; NaN when none |
| existing_battery_kwh | float | kWh | battery already installed; NaN when none or when the entry is the planned battery (see flag) |
| existing_battery_is_planned | bool | | has_storage was set but built year ≥ offer year or an option sells exactly that kWh, i.e. the planner entered the battery being sold (9 of 11 cases) |
| has_existing_wallbox | bool | | wallbox already installed |
| heating_type | str | | existing heating: Heatpump, Gas, Oil, OtherNonRenewable, OtherRenewable, `Unknown` (88% empty) |
| heating_demand_kwh | float | kWh | yearly heating demand; mostly NaN |
| heating_electricity_kwh | float | kWh | electricity used by an existing heat pump; mostly NaN |
| house_sqm, house_built_year, inhabitants | float | m², year, persons | < 1% filled; planner-entered optional inputs only |

### Flags
| column | type | meaning |
|---|---|---|
| pv_implausible | bool | full design with 0 < pv_kwp < 1.0: the planner left placeholder quantities (e.g. one "PV Module 463W" next to a 15-20 kWp roof-mounting tier); the true size is unknown, so it is not guessed |
| is_outlier | bool | pv_kwp > 30 or battery_kwh > 40 (commercial-size) or pv_implausible; exclude from training and evaluation |
| pv_sources_disagree | bool | two PV sources in the option give different sizes; the value kept follows the source order in the rules |

### Extra columns (helpers, may be ignored)
| column | type | meaning |
|---|---|---|
| items_signature | str | sorted "name|qty" list of the option's line items; used for is_duplicate_option |
| has_solar | bool | raw status-quo flag (existing PV), used for offer_type |
| storage_kwh_entered | float | kWh entered as "existing storage" before the planned-battery check |

## Physics assumptions (engine/physics.py, branch engine/physics)
Hourly synthetic year (8,760 h), deterministic with a fixed seed. Synthetic shapes, NOT the official BDEW / weather tables.
- PV: 950 kWh/kWp/yr for south ~30–35°; orientation/tilt factor grid (E/W 30° ≈ 0.85, flat ≈ 0.88, north 30° ≈ 0.62,
  vertical south ≈ 0.70). Missing orientation/tilt → south, 30° (reported in `assumptions`). Monthly split of the yearly
  yield (Jan 2.7 % … Jul 13.6 %), daylight bell at 48° N, east roofs peak earlier, west later.
- Weather: seeded sunny/cloudy factor per day (Beta 0.7/0.9, darkest day 2 % of clear) + hour-to-hour PV spread
  (lognormal σ 0.4); each month keeps its share of the yearly yield.
- Household load: H0-like 24 h shape; Reonic presets as multipliers on day/morning/evening presence
  (HomeOffice/Senior ↑ day, FullTime ↓ day, Family ↑ morning+evening); weekend daytime ×1.2; seasonal ±17 %;
  hour-to-hour appliance spread (lognormal σ 0.9). `CustomFromEditor`/unknown → H0.
- EV: km/100 × 18 kWh, charged 18–23 h (option "solar": 10–15 h). Unknown distance → 12,000 km.
- Heat pump: size = heat demand / 2,450 full-load hours (median of the 13 heat-pump projects of installer_a), snapped to
  the installer's sizes (installer_a sold 5.5 / 7.5 / 8 / 10.5 / 12.5 kW); electricity = heat demand / SCOP 3.5, by heating-degree-day month share + 15 % flat hot water.
  Only for gas/oil/other non-renewable heating; never if a heat pump exists or the installer sells none.
- Battery: 90 % usable, 0.5 C, 95 % one-way efficiency, self-consumption-first dispatch.
- Self-consumption = PV used in the home / PV produced; autarky = PV used in the home / consumption.
- Calibration (tests enforce it): 4,500 kWh + 5 kWp → SC 30 % / autarky 32 %; + 5 kWh battery → 54 %;
  10 kWp + 10 kWh → 76 % (HTW-Berlin rule-of-thumb ranges). Known optimism: very small homes with large systems
  (3,000 kWh, 10 kWp + 10 kWh → 88 %, real ~80–85 %).
- Economics: every price is a placeholder in `engine/config/economics.toml` (data has no prices).

## Label table contract (proposed by engine/physics — engine/labels please confirm or tell Cala)
`engine/evaluate.py` reads `engine/artifacts/expert_designs.parquet` (or .csv). **One row per project × offer option.**

| column | type | required | meaning |
|---|---|---|---|
| project_id | str | yes | joins to projects_status_quo.csv |
| installer | str | yes | folder name, e.g. installer_a |
| option_number | int | yes | offer option number |
| is_primary | bool | yes | exactly one True per project (the expert design we score against) |
| has_pv / pv_kwp | bool / float | yes | pv_kwp = 0 when no PV |
| has_battery / battery_kwh | bool / float | yes | battery_kwh = 0 when no battery; extensions summed |
| has_wallbox | bool | yes | |
| has_heatpump / heatpump_kw | bool / float | yes | heatpump_kw = 0 when none |
| option_id, wallbox_kw, inverter_kw | str / float | optional | |

Home inputs are NOT needed in the label table: evaluate.py joins them from data/raw (`load_inputs()`, api.md names).
Variant range per project = min/max of pv_kwp and battery_kwh over all its options (computed by evaluate.py).
`engine/artifacts/catalogue.json` is read as `{installer: [battery sizes]}` or `{installer: {"battery_kwh": [...]}}`;
if absent, sizes seen ≥ 5× per installer in the labels are used.

## Evaluation protocol (engine/evaluate.py)
- Held-out: 80/20 split by project_id, stratified by installer, seed 42. Transfer: train on one installer, test on the other.
- Truth = primary option. PV MAE on projects with expert PV; battery MAE + "within one catalogue step" on projects with
  an expert battery (predicting no battery = size miss). Yes/no accuracy per component. NaN predictions = misses
  (excluded from MAE but counted).
- Variant-range hit rate on all projects: strict = inside [min, max]; tolerant = PV ± 1.0 kWp, battery ± 1 catalogue step
  (step 0 = no battery).
- Baselines: kWp = annual kWh / 1000 (battery = installer's most common size, yes/no = majority), and median/mode per
  installer × consumption band (0–2.5–3.5–4.5–5.5–7–9–∞ MWh).

## Offer type and the existing-PV question (engine/model.py)
- Offer type per option (engine/labels v1.1 names): new_system, pv_extension, battery_retrofit, wallbox_only, heatpump_only,
  no_components. Interim labels derive it from the parsed design + recorded existing PV.
- ASSUMPTION: a battery-only offer means PV is already on the roof (a battery without PV makes no sense). The planner's
  answer to "Is there already PV on the roof?" is therefore taken as yes for battery_retrofit / pv_extension, no for
  new_system, unknown for wallbox_only / other. `has_solar = False` in the data means "not answered", not "no".
- Training uses every project twice (answered + unanswered) so the model works with and without the answer.

- Voice calls (d-voice, web/src/lib/voice.ts): `daytime_presence` maps to a `load_profile` preset only for one-person
  households (home during the day → `HomeOfficeOnePerson`, out → `FullTimeOnePerson`), mirroring the engine's own note
  parser (engine/llm.py: "home office" → `HomeOfficeOnePerson`). Multi-person homes keep `H0` because no preset
  describes their daytime presence. Household answers in words are parsed to a number (capped at 20).
