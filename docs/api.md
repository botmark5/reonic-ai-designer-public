# Engine API contract (v0 — change only when Cala and Mark both agree)

## POST /design
Request:
{ "installer": "installer_a",
  "home": { "annual_kwh": 4500, "price_eur_kwh": 0.32, "load_profile": "H0", "has_ev": false, "ev_km_year": null,
            "existing_pv_kwp": null, "existing_battery_kwh": null, "heating": "Gas", "heating_demand_kwh": null,
            "roof_type": null, "house_sqm": null, "inhabitants": null },
  "locks": { "pv_kwp": null, "battery_kwh": null, "wallbox": null, "heatpump_kw": null } }
Response:
{ "design": {
    "pv":       { "include": true,  "kwp": 9.0,  "range": [8.1, 10.4], "confidence": 0.78, "reasons": ["..."] },
    "battery":  { "include": true,  "kwh": 10,   "range": [7, 10],     "confidence": 0.71, "reasons": ["..."] },
    "wallbox":  { "include": false, "kw": null,  "confidence": 0.90,   "reasons": ["..."] },
    "heatpump": { "include": false, "kw": null,  "confidence": 0.60,   "reasons": ["..."] } },
  "physics": { "yield_kwh": 8550, "self_consumption": 0.62, "autarky": 0.71, "warnings": [] },
  "similar_homes": [ { "project_id": "...", "annual_kwh": 4400, "pv_kwp": 9.0, "battery_kwh": 10, "similarity": 0.93 } ],
  "facts_for_explanation": { "...": "engine facts Claude turns into prose" },
  "model_version": "v0" }

## POST /validate
Request: { "installer": "...", "home": {...}, "design": { "pv_kwp": 14, "battery_kwh": 15, "wallbox": true, "heatpump_kw": null } }
Response: { "flags": [ { "component": "battery", "level": "warn", "percentile": 96, "message": "Larger than 96% of similar homes" } ] }

## POST /refine   (Claude Haiku: text → input changes; then calls /design)
Request: { "text": "family is buying an EV next year", "home": {...}, "locks": {...} }
Response: { "changes": { "has_ev": true, "ev_km_year": 15000 }, "design": { ...as /design... } }

## POST /explain  (Claude Sonnet, streamed): { "design_response": {...}, "audience": "planner" | "homeowner" } → text

## GET /eval → { "metrics": {...}, "by_installer": {...}, "baselines": {...} }
## GET /project/{id} → { "home": {...}, "expert": {...}, "variants": [...], "ours": {...} }

## Additions (engine, additive and optional; nothing renamed or removed)
- `home.has_existing_pv`: true / false / null ("Solar already on the roof?").
- `home.roof_max_kwp`, `home.roof_azimuth` (degrees clockwise from north, 180 = south), `home.roof_pitch` (degrees):
  from the Google Solar API. PV is capped at `roof_max_kwp` (whole 450 W panels; a planner lock above it is kept and
  flagged `ROOF_CAPACITY_EXCEEDED`); azimuth/pitch drive yield, self-consumption and economics (PVGIS factors).
- Response: `options.heatpump` (design with and without a heat pump), `economics`, `physics.flags`,
  `battery.alternatives`, `facts_for_explanation.offer_type`. Header `X-Engine-Key` on every endpoint except `/health`.
- `home.demand_is_default` (bool, optional): true only when `annual_kwh` was left at the tool's default 4,500 kWh. The model learned
  that this default often means "consumption unknown" (battery retrofits); a typed value is real (`false` / omitted). `/project/{id}`
  sends the flag as recorded in the data.
- `home.annual_kwh` below 1,500 kWh is rejected with HTTP 422 (placeholder entries; nothing can be sized from them).
- `battery.range` always contains `battery.kwh`; `battery.alternatives` are other catalogue sizes with the classifier's shares (> 0); since 8 Nov one smaller and one larger, see below.
- Heat pump sizes (`options.heatpump.kw`, `heatpump.kw`) come from the installer's catalogue as sold (installer_a: 5.5 / 7.5 / 8 / 10.5 / 12.5 kW);
  the physics size check uses the same list.
- `physics.flags` thresholds are calibrated on the experts' own new-system designs (8 Nov, issue #66): PV yield / consumption
  above 2.5 (p75 of expert designs) = `PV_MOSTLY_FED_IN` (info), above 4.0 (~p96) = `PV_OVERSIZED` (warn), above 5.5 (p99) =
  `PV_VERY_OVERSIZED` (error); battery above 2.0 kWh per kWp (~p98) = `BATTERY_TOO_BIG_FOR_PV` (warn). On `/design` a
  `PV_OVERSIZED` warning is downgraded to info when the 40 most similar past homes show the size is typical for that consumption.
- `GET /project/{id}?answered=true` (optional, default false): builds `ours` with `home.has_existing_pv` set the way the
  answered-mode evaluation derives it from the expert offer (battery-only / PV extension = yes, new system = no, else null).
  Response adds `answered` (bool) and `planner_answer` (true / false / null). It is a what-if, never an accuracy (issue #47).
- `pv.alternatives` and `battery.alternatives` are now a bracket around the proposal: the most likely size the installer sells BELOW it and the most likely size ABOVE it (sorted ascending, each with the classifier's share). When one side has nothing (smallest / largest size, roof cap) the next most likely other size fills in. Same shape as before; locked test: the expert's PV is within 1.5 kWp of one of the 3 options in 70 % of homes (unchanged), and 77 % of proposals get one smaller and one larger option (was 45 %).
- `GET /heldout` (issue #94, same `X-Engine-Key` as `/eval`) → `{ "test_project_ids": ["…"], "demo_projects": [{ "role", "why", "project_id" }] }`:
  the locked held-out ids and the curated demo cases, ids and text only (details via `/project/{id}`). Reads
  `engine/artifacts/test_ids.json`, `demo_reality.json` (roles prefixed `two_houses_`, listed first) and `demo_projects.json`;
  a missing file is rebuilt from the labels with the same fixed rules. For hosts without the artifacts (Vercel).
- `GET /eval` adds `by_band` (issue #79): `{ "<band>": { "design_model": {...}, "baseline_kwh_per_1000": {...}, "baseline_band_median": {...},
  "baseline_kwp_per_mwh": {...} } }`, each predictor block = the same metrics as `metrics` (`n_projects`, `pv_n`, `pv_kwp_mae_when_both_pv`,
  `has_pv_accuracy`, …) plus `pv_kwp_bias_when_both_pv` = mean(ours − expert) where both chose solar (negative = we size smaller).
  Bands = yearly consumption `0-3000`, `3000-4500`, `4500-6000`, `6000-9000`, `9000+` (kWh, upper bound inclusive) and
  `not_entered` (consumption left at the 4,500 kWh default), same as deck chart 2a. Locked test set, without the existing-PV answer.
  Bands with no test project are omitted. Written by `python -m engine.train` or, without a retrain, `python -m engine.eval_bands`.
