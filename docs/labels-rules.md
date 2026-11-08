# Expert-design extraction rules (Phase 1, steps 2 + 3)

Status: APPROVED by Mark 2026-11-07 (roof: option a; primary prefers full designs; install-only wallbox = yes, kW unknown). Implements the schema in `docs/data-notes.md` → "expert_designs.parquet schema".
Every rule works on the line items of ONE option (project × option_number). Examples are real options
(installer prefix · project id prefix · option number). Raw column names are used as they are in the CSV;
remember they are shifted: `inverter_power_kw` holds battery Wh, `battery_capacity_kwh` holds inverter W.

Approved decisions this builds on: primary = lowest option_number present · installer_a panels = 450 W ·
battery from numeric column, name fallback · keep every row with offer_type + is_full_design ·
flags for bad status-quo values; default 4,500 kWh = consumption unknown.

---

## Step 2 — extraction rules

### R1 PV size (pv_kwp, pv_panels, pv_source, pv_wp_assumed, pv_sources_disagree)
Per-panel count sources: `Substructure *` qty, `DC Install *` qty (installer_a), `Roof Mounting *` qty without
"Surcharge" (installer_b), `Module` rows (qty × `module_watt_peak`). Packages: `PV Complete Package N kW` (A),
`Complete Package … X kWp + Y kWh` (B).

Order (first that applies wins; any other source that gives a different size sets `pv_sources_disagree`):
1. **Module lines** with wattage → Σ qty × `module_watt_peak`. If a B package is also present:
   module lines are the total count (planner up- or downsized the package), EXCEPT
   (a) module qty < half the package's panel count → package + module lines (an extra panel), and
   (b) module qty == package panel count and an "N x Extra PV Module" / "N Additional Modules" line exists → add N × that wattage.
2. **B package name** X kWp (+ named extras "N Additional Modules" × 450 W).
3. **A per-panel count** × 450 W: Substructure qty summed over roof types; if Substructure ≤ 1 and DC Install > 1, use DC Install.
   A per-panel count beats a A "PV Complete Package N kW" name.
4. **A package name** N kW → N kWp (panels NaN).
5. **B Roof Mounting** qty × 450 W, only if qty ≥ 2; else Substructure qty ≥ 2 × 450 W.
6. **B size band** only ("Substructure 6-8.8kWp" with qty 1) → band midpoint, source `size_band`.
7. Nothing → pv_kwp 0, source `none`.

pv_wp_assumed = 450 when rule 3 or 5 used, else NaN.

Rulings made during implementation (2026-11-07):
- Rule 1(a) applies only when module qty ≤ 3 (`MAX_EXTRA_MODULE_LINES`). Example 12 (16 modules vs an 18 kWp = 40-panel
  package, Roof Mounting 16) is a downsize, not an extra; the literal "less than half" text is replaced by this.
- Rule 1(b): named extras get the module lines' wattage (example 14 → 27 × 475 W); in rule 2 the wattage in the extra's name, else 450 W.
- `pv_sources_disagree` ignores one-unit kits only for installer_b. 41 options are flagged (35 in B: unnamed 2–3 extra panels
  next to a package, 480 W modules vs the package's 450 W math, planner downsizes). Informational only.
- Panel counts skip "Substructure Flat Roof Ballast" (a ×1 kit line, 16 lines, all B); roof type still reads it as Flat.
  This removed 13 false disagree flags; no size changed.
- A lone "Substructure up to X kWp" ×1 gives no size (0 real cases).

| # | option | line items (short) | result | why |
|---|---|---|---|---|
| 1 | A·ex01·1 | Substructure Concrete Roof 19, DC Install 19, Optimizer 19, Scaffolding 19 m² | 19 panels, 8.55 kWp, substructure | standard case; scaffolding qty is m², ignored |
| 2 | A·ex02·5 | Substructure 1, DC Install 13, Optimizer 13 | 13 panels, 5.85, disagree | Substructure ≤ 1 → DC Install |
| 3 | A·ex03·2 | Substructure 30, DC Install 1 | 30 panels, 13.5, disagree | substructure wins |
| 4 | A·ex04·1 | Substructure 18, DC Slate 9 + DC Concrete Tile 12 | 18 panels, 8.1, disagree | substructure wins (scaffold 18 m² agrees) |
| 5 | A·ex05·1 | Substructure Clay 2 + Flat East/West 4 | 6 panels, 2.7 | sum over roof types |
| 6 | A·ex06·1 | PV Complete Package 5kW, no per-panel lines | 5.0 kWp, panels NaN, package_name | package fallback |
| 7 | A·ex07·1 | PV Complete Package 8kW + DC Install 20 | 20 panels, 9.0, disagree | per-panel count beats A package (optimizer counts vs package kW are inconsistent: 300–1,500 W/panel in 26 options) |
| 8 | A·ex08·3 | PV Module 475W ×5, Substructure 5 | 5 panels, 2.375, wp_assumed NaN | module wattage known |
| 9 | A·ex09·1 | solar-tagged: Meter Consolidation B, Travel & Logistics Flat Rate - Extension | 0, none | fees only |
| 10 | B·ex10·1 | Package 10.8kWp + 9kWh, Roof Mounting 26, Substructure 26 | 10.8, disagree | package beats roof mounting (4 such conflicts) |
| 11 | B·ex11·3 | Package 10.8, Module 463W(col 450) ×27, "Additional Module" ×3 | 27 panels, 12.15 | module lines are the total |
| 12 | B·ex12·7 | Package 18kWp, Module ×16 @450 | 16 panels, 7.2, disagree | planner downsized |
| 13 | B·ex13·6 | Package 13.5, Module 480W(col 475) ×1 | 13.975 | module qty < half of 30 → package + 1 |
| 14 | B·ex14·2 | Package 10.8, Module ×24 @475, "3x Extra PV Module 480W", Roof Mounting 3 | 27 panels @475 = 12.825 | module qty == package count + named extras |
| 15 | B·ex15·1 | Package 6.3, "4 Additional Modules (beyond Package)" | 6.3 + 1.8 = 8.1 | named extras, no module lines |
| 16 | B·ex16·1 | Substructure 1, Roof Mounting 35, Micro Inverter 2000W | 35 panels, 15.75 | roof mounting count; substructure 1 is a kit |
| 17 | B·ex17·2 | Roof Mounting 1, Substructure 6-8.8kWp 1 | 7.4, size_band | only the band is known |
| 18 | B·ex18·1 | Module ×222 | 99.9 kWp → is_outlier | commercial |

Module wattage in B: the column is the installer's planning value (name "463W" → 450, "480W" → 475); the package math uses
the same 450 W (24 × 450 = 10.8). We use the column.

### R2 Battery (battery_kwh, battery_source)
1. Σ over `BatteryStorage` rows of qty × `inverter_power_kw` / 1000, excluding "AC Coupling Module" (Flowmax coupler, 1,980 W, not storage).
2. Rows with no column value: parse "N kWh" from the name (also `AccessoryToBatteryStorage` rows named "Battery N kWh Extension");
   never "Extended Warranty …", "… Tower", "Power Module".
3. No battery rows → B package "+ Y kWh".  4. Else 0, `none`.
Inverter rows are never battery, even though their shifted column says 6000–20000.

| # | option | line items | result | why |
|---|---|---|---|---|
| 1 | A·ex01·1 | Battery 7kWh (col 7000) | 7.0, numeric_column | |
| 2 | A·ex19·5 | Battery LFP 15kWh ×2, AC Coupling Module (Free) | 30.0 | qty counts; coupler excluded |
| 3 | A·ex20·1 | accessory "Battery 5kWh Extension", no column | 5.0, name | retrofit extension |
| 4 | B·ex21·2 | Package 18kWp + 9kWh, AIO 9kWh ×2 | 18.0 | lines beat package (planner added a module) |
| 5 | B·ex22·1 | Package 13.5kWp + 9kWh, AIO 6kWh ×1 | 6.0 | planner swapped battery |
| 6 | B·ex23·2 | Package 10.8 + 9kWh, AIO 9kWh + AIO 6kWh | 15.0 | sum of rows |
| 7 | B·ex24·5 | Package 10.8 + 10kWh, Kestrel Battery 5kWh L3 (col 14760) | 14.76 | column: L3 = 3 modules × 4.92 |
| 8 | B·ex25·2 | Package 6.3 + 6.6kWh, Kestrel 3.3kWh L3 (col 9600) | 9.6 | same |
| 9 | B·ex26·1 | Package 10.8kWp + 9kWh B, no battery row | 9.0, package_name | fallback (72 options) |
| 10 | B·ex27·1 | AIO 9kWh, "Extended Warranty Storage 9kWh" | 9.0 | warranty ignored |
| 11 | B·ex18·1 | Stack Battery 12kWh ×9, Main Tower, Next Tower | 108 → is_outlier | towers ignored |
| 12 | B (Flowmax) | Flowmax Battery 5.1kWh (col 4800) | 4.8 | column = installer's planned usable kWh |
All 28 package-vs-lines conflicts in B are explained by rows 4–8 (added module, swap, multi-level Kestrel).

### R3 Wallbox (wallbox, wallbox_kw, n_wallboxes)
wallbox = a `Wallbox` row, OR a wallbox installation fee ("Install Wallbox", "Wallbox Installation") or "All-Inclusive Package - Wallbox".
"Prep …" lines and "Power Boost for Existing Wallbox" alone → False. wallbox_kw = `wb_charging_speed_kw`/1000 of the Wallbox row
(NaN when installed without a Wallbox row); n_wallboxes = Σ qty of Wallbox rows (≥ 1 when wallbox).
Added after the final review: a wallbox sold only as a promo/product line of type Other ("Free 11kW Charging Wallbox Promo",
"EV Charger Plus") also counts (kW from the name, n = 1); promo text next to a real Wallbox row never adds a second one.
Matched 2 real B options.

| # | option | line items | result |
|---|---|---|---|
| 1 | A Huawei | "Wallbox" (col 22000) | True, 22 kW (name has no kW; 180 rows) |
| 2 | A SolarEdge | "Smart EV Charger 22kW Approved" (col 11000) | True, 11 kW (column, like battery) |
| 3 | A·ex28·1 | Wallbox qty 2 | True, 22, n=2 |
| 4 | A·ex29·1 | Install Wallbox only | True, NaN kW (23 such options: customer's own / bundled) |
| 5 | A·ex30·1 | Wallbox Component On-Site + Install Wallbox | True, NaN |
| 6 | A·ex31·1 | Prep Wallbox | False (3 options) |
| 7 | A·ex32·1 | All-Inclusive Package - Wallbox + Travel & Logistics Flat Rate - Wallbox | True, NaN |
| 8 | A (1 option) | Power Boost for Existing Wallbox | False |
| 9 | B·ex33·1 | "Winter Promo Free Wallbox with PV" + Voltara AC Wallbox | True, kW from row |
| 10 | A Flowmax | Wallbox 11kW Gen2 (Free) | True, 11 |

### R4 Heat pump (heatpump, heatpump_kw)
heatpump = a `Heatpump` row (no option has storage/buffer without one). kW from the name ("Heat Pump 10.5kW 400V" → 10.5),
column only if the name has no number: the column is rounded (10.5 → 10000) or wrong (Aira "Heat Pump 8kW" → 10140).
Only 31 options / 17 projects, all installer_a: 5.5 (6), 7.5 (5), 8 (2), 10.5 (14), 12.5 (4). Heat pump = rules + physics in Phase 2.

### R5 Inverter (inverter_kw)
Rows whose name contains "Inverter" and type is `Inverter` or `Other` (not fees/accessories). kW from the name
("Voltara Hybrid Inverter 25kW", column 4049 → 25); micro inverters "Micro Inverter 2000W" ×qty → kW. Sum over rows. None → NaN.
Examples: Voltara 10kW (col 10000) → 10 · Voltara 25kW (col 4049) → 25 · Micro Inverter 1000W ×3 → 3.0 ·
Micro Inverter 1600W ×2 → 3.2 · Gridwell String Inverter 8kW (type Other) → 8 · A "Hybrid Inverter 15kW" (technology empty) → 15 ·
A typical option (no inverter row, Huawei inverter inside "Install Inverter" fee) → NaN. Filled for ~6 A options and ~60 B options.

### R6 Roof type (roof_type)
From `Substructure …` / `DC Install …` / B surcharge names. Normalise: strip pitch (">30°", "<30°", "<15°"), "Rack System",
"Mounting", "East/West", "South", trailing " B"/" C"; **merge "Concrete Roof" → Concrete Tile and "Clay Roof" → Clay Tile**
(catalogue rename: the old names stop in Jan 2025, the new ones start then — crosstab by month).
Map: Flat Roof*, Green Roof, Flat Roof Ballast → Flat · Metal Roof, Standing Seam*, Trapezoidal Sheet → Metal · Bitumen ·
Slate · Beaver Tail Tile (+ B "Beaver Tail Tile (Surcharge)") · B "Mortared Tiles (Surcharge)" → Clay Tile · Facade.
B kWp-band and Cross-Lay names carry no roof cover → Unknown.
Several types in one option → **judgement call**:
 (a) roof_type = type with the most panels + `roof_mixed` bool [recommended: usable as a feature, keeps the information];
 (b) roof_type = "Mixed" (as the schema says now). → choose a, and I update the schema line.
Examples: 1 "Substructure Concrete Roof" (2024) → Concrete Tile · 2 "Clay Tile Roof" + "Flat Roof" 4 → Clay/Flat by panel count, mixed ·
3 "DC Install Concrete Roof >30°" → Concrete Tile · 4 "Substructure Flat Roof East/West" → Flat · 5 "Substructure Green Roof PV East/West" → Flat ·
6 "Substructure Standing Seam B" → Metal · 7 "Substructure Bitumen Roof Mounting" → Bitumen · 8 B "Substructure 8.8-15kWp" → Unknown ·
9 B "Substructure Flat Roof Ballast" → Flat · 10 B "Roof Mounting Beaver Tail Tile (Surcharge)" → Beaver Tail Tile.
Unknown for ~410 A options (mostly no PV) and most B options.

### R7 Scaffolding (has_scaffolding)
True if any line name contains "Scaffold" (all A variants, incl. "- Quote", "Provided by Customer" = scaffold needed) or is
B "Site Setup / Safety (…)". A: 1,031 of 1,220 PV options; B: 205. Absence is not explained by roof type
(56 Concrete Tile and 55 Clay Tile options without it), so it is a label, not a roof proxy.

### R8 Brand (brand) and backup (has_backup)
brand = brand of the battery row, else inverter row, else wallbox row; if `component_brand` is empty, the first word of the
product name when it is a known brand (B "Gridwell Battery 5kWh B" → Gridwell; "Kestrel Wallbox 11kW" → Kestrel); else the brand of
an energy manager / optimizer / smart meter row (Huawei, SAJ, SolarEdge, Enphase); else Unknown. Module, cable, insurer,
substructure and heat pump brands (Sunpro, Mennekes, Insurer, Novotegra, Vaillant …) never count.
Example B·ex34·1 Flowmax + Voltara rows → brand of the battery row.
has_backup = "Smart Guard", "Backup Box", "Emergency Power", "Backup Solution", "Home Backup Interface", "Transfer Switch" in any name.

---

## Step 3 — edge cases, proposed decisions

| case | evidence | proposed decision |
|---|---|---|
| Retrofit onto existing PV | has_solar True in 18 projects (A only); 130 battery-only options have has_solar False, so the flag under-reports | offer with new PV + (has_solar or "Stringing Existing Modules" or "All-Inclusive Package - Extension" / "Travel & Logistics Flat Rate - Extension" fee (plain hyphen, as in the data)) → `pv_extension`; module replacement (A·ex35: PV Module 400W ×3 + "Removal of Old PV Module" ×3) → `pv_extension`. Not full designs. |
| Battery-only offers | 199 (A) + 11 (B) options; 187 with "Extension" wording | `battery_retrofit` (also with a wallbox). Kept for the battery-size catalogue, not for the main chain. |
| Wallbox-only / heat-pump-only | 70 / 21 options | `wallbox_only` / `heatpump_only`. Heat-pump-only rows still feed the heat-pump rules. |
| EV without wallbox | 24 (A) + 7 (B) options with has_ev and no wallbox | keep as is: a real expert decision (existing charger, socket). |
| Wallbox without EV | 406 + 64 options | keep: installers upsell; has_ev is a weak signal. Reported in data notes. |
| Very large systems | 1 option > 30 kWp (99.9), batteries > 40 kWh: 45 (A), 108 (B) | `is_outlier`, kept in file, excluded from training and evaluation. |
| Placeholder PV quantities | full designs with 0 < pv_kwp < 1 (e.g. B·ex36: 1 module next to a "15-30kWp" tier and a 12 kW inverter): 6 options | `pv_implausible`, also `is_outlier` (added after the final review). |
| Projects with no parts | 20 + 6, all at the 4,500 kWh default | not in the parquet; counted in data notes. |
| Exact duplicate options | 64 projects (A), 4 (B) | `is_duplicate_option` on the higher number; kept; ranges unchanged. |
| Variants differing only in battery | 75 projects (A) | keep all; battery range = min/max. Lowest option is the smallest battery in 77 projects and the largest in 48, so evaluation must also report range-hit, not only error vs the primary. |
| Options with no sizeable component | 33 (A) + 1 (B) | `no_components`, excluded. |
| has_storage = planned battery | 11 has_storage homes. B: all 5 have built year = offer year and the package sells the same kWh (e.g. ex37: "existing" 10 kWh, package "+ 10kWh"). A: ex38 (no year) sells Battery 7kWh = "existing" 7; ex39, ex40, ex41 built 2026 ≥ offer year. Only ex42 (5 kWh) and ex43 (10 kWh) look real: no year, nothing battery sold. | `existing_battery_is_planned` when storage_built_year ≥ offer year OR an option of the project sells exactly that kWh; then existing_battery_kwh NaN. 9 of 11 are planned; 2 real existing batteries remain. |
| Consumption default / invalid | 410 + 69 at exactly 4,500; 21 at 0–1 kWh | annual_kwh NaN, consumption_known False; evaluation reportable on consumption_known only. |
| Price typed in €/kWh or 0 | A one 0.32282, two 0.0 | 0.32282 kept as €/kWh; 0 → NaN. |
| Signed before offer created | 2 (B) | keep; no effect on labels. |
| Same customer, two projects | 41 (A), 1 (B) | keep both; splits grouped by customer_contact_id. |
| A "PV Complete Package N kW" | 73 options; optimizer counts imply 300–1,500 W/panel | treat N as kWp, source `package_name`; flagged as the least certain PV source. |

Primary label: `is_primary` = lowest option_number among the project's options **with is_full_design** when the project has one
(otherwise lowest overall), so the training row of a project is never a retrofit add-on when a full design exists.
