# Engine spec — Phase 2 notes from the labels side

Status: proposal (2026-11-07). Phase 2 (physics, chained model, evaluation, API) was already built by Cala on main;
this document does not redesign it. It states what the expert-design labels can and cannot support, and the
changes the model and evaluation need to use them correctly. Numbers are from `engine/artifacts/expert_designs.parquet`
(primary rows, full new-system designs, outliers excluded: 984 homes for installer_a, 326 for installer_b).

## 1. How to read the label table (must-do for train.py / evaluate.py)
- **Training and evaluation rows:** `is_primary & is_full_design & ~is_outlier`. 282 of 1,593 primary rows are battery
  retrofits, wallbox-only or extension offers; 269 of them have `pv_kwp == 0` because the home already has PV, not
  because the expert chose "no PV". Today evaluate.py and train.py do not filter on `is_full_design`, so they learn
  and score these as "no PV".
- **Home inputs:** use the cleaned columns from the parquet, not raw status quo: `annual_kwh` (NaN for the 4,500 kWh
  default and for 0–1 kWh entries), `consumption_known`, `price_eur_kwh` (fixes the one value typed in €/kWh, which raw
  ×1000 turns into 322.82 €/kWh), `existing_battery_kwh` (planned batteries blanked).
- **Variant ranges:** `pv_kwp_min/max`, `battery_kwh_min/max` are computed over the project's options with the same
  `is_full_design`, so a retrofit add-on never widens a full design's range. Use them for the range-hit metric.
- **Splits:** group by `customer_contact_id` (41 customers have two projects). Already done on main.

## 2. Where the data cannot support a learned decision, and what to do instead
| decision | evidence | instead |
|---|---|---|
| Heat pump yes/size | 31 options in 17 projects, all installer_a; 7 primary full designs | rules + physics (heating demand ÷ full-load hours, snapped to the catalogue 5.5/7.5/8/10.5/12.5 kW). Already the plan on main. |
| PV vs consumption for 1/3 of homes | demand is the 4,500 default in 16% (A) / 19% (B) of these rows | treat default as missing (NaN), train with consumption_known as a feature, and report metrics on consumption_known homes separately. |
| "No battery" | 5.6% (A) / 1.2% (B) of primary full designs | do not expect a classifier to learn it from 60 cases; predict battery yes by default, "no" only via explicit rules (existing battery, homeowner choice, lock). |
| Inverter size | known for 6 A options and ~60 B options | derive from PV size with a rule (DC/AC ratio) and the catalogue; do not learn. |
| Roof type as a feature | known for 94% of A rows, 9% of B rows | use only as an optional planner input; never required. |
| Household type | load_profile is H0 (unknown) in 90%+ | optional planner input feeding physics; not a model feature. |
| Wallbox | 63% with has_ev vs 24% without (59 EV homes) | learnable but noisy: model it from has_ev + PV size, and keep it a planner-visible suggestion with low confidence when has_ev is False. |
| Installer transfer | installer_b has 326 training homes, other brands and package-based catalogue | snap to each installer's own catalogue (`catalogue.json`); report A→B transfer as a finding, not a promise. |

## 3. Baselines and sizing facts the model should beat
- Installers size PV at a median **1.9 kWp per MWh** of demand (A) and **2.2** (B), so the "kWp = kWh/1000"
  baseline undersizes by about half. Keep it as the naive baseline, and add "kWp = 2 × MWh, snapped" as a stronger one.
- Battery ≈ PV: median battery/PV ratio 0.97 (A) and 0.93 (B). Correlation of demand with PV is 0.50 / 0.42 and with
  battery 0.42 / 0.39 on homes with real consumption, so a large part of the variance is installer or homeowner preference.
- A PV sizes rest on 450 W per panel. At 430 / 475 W the median primary design moves from 9.0 to 8.6 / 9.5 kWp;
  report PV error in panels as well as kWp for A.

## 4. Evaluation protocol additions
- Report on three slices: all full designs; consumption_known only; each installer.
- Primary metric pair: error vs the primary option, and **range hit rate** (prediction inside the expert's variant range),
  since which option was signed is not recorded. 236 homes have 2+ full-design variants (PV differs in 78, battery in 103).
- Exclude `is_outlier` rows (commercial-size systems and placeholder PV under 1 kWp).
- Error analysis by `pv_source` (package_name and size_band are the least certain labels) and by `pv_sources_disagree`.
