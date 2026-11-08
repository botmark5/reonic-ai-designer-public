# Cala: physics.py + evaluate.py details (add to your current task)
Physics (engine/physics.py), external data allowed for PHYSICS ONLY, never as training labels:
- Solar yield: PVGIS API (EU JRC, free, no key): https://re.jrc.ec.europa.eu/api/v5_3/PVcalc?lat=..&lon=..&peakpower=1&loss=14&angle=35&aspect=0&outputformat=json
  Cache one result per (angle, aspect) for a central German location (e.g. Augsburg 48.37, 10.90) plus a lookup table;
  default ~950 kWh/kWp if offline. Accept lat/lng/pitch/azimuth when the Google Solar lookup provides them.
- Household load: BDEW standard load profile H0 (public, 15-min values, scaled to annual kWh). Reonic presets
  (FamilyOfFour, HomeOfficeOnePerson…) = shift more load into daytime; approximate with a daytime multiplier.
- Self-consumption / autarky: simple hourly simulation (PV hourly shape × H0 × battery state of charge, 90% round trip).
  Sanity-check against the HTW Berlin "Unabhängigkeitsrechner" curves (autarky rises steeply to ~1 kWh battery per
  1,000 kWh demand, then flattens).
- EV: km/year × ~0.18 kWh/km added to demand, mostly evening load. Heat pump: heating demand / SCOP 3.5 added as winter load;
  size kW ≈ heating demand kWh / 2,000 full-load hours, snapped to 5 / 7 / 8 / 10 / 12 kW.
- Economics from a config file of price assumptions (placeholders until Reonic answers): €/kWp, €/kWh battery,
  feed-in ct/kWh, electricity price from the home.
Evaluation (engine/evaluate.py):
1. Lock a 20% TEST set first, grouped by customer_contact_id (StratifiedGroupKFold or GroupShuffleSplit, seed 42),
   saved as test_ids.json. Never tune on it; report it once at the end.
2. Tune on the 80% with 5-fold cross-validation, also grouped by customer.
3. Baselines: kWp = annual kWh / 1000; median per consumption band. Our model must beat both.
4. Installer transfer: train on installer_a → test on installer_b, and the reverse.
5. Report: overall, real-consumption homes only (demand_is_default == False), new_system only; plus hit rate inside the
   expert's variant range (min/max over options).
Labels: Mark's engine/labels branch defines docs/data-notes.md "## expert_designs.parquet schema"; match it.
