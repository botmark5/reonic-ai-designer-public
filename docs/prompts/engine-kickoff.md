Read CLAUDE.md, docs/data-notes.md, docs/api.md and docs/PLAN.md first, then skim docs/reonic-brief.pdf.

You are the engine lead for our Reonic hackathon project. Goal of this session: Phase 1 — turn the raw data into a
trustworthy "expert design" table we can train and evaluate on. Correctness matters more than speed: everything
downstream (model, metrics, demo) inherits mistakes made here.

Work in this order and STOP after each step to show me the result (tables, counts, examples) before continuing:

1. Profile both installers in data/raw/ (projects_status_quo.csv + project_options_parts.csv): fill rate and value
   distribution of every column, how many options per project, line-item types per technology, outliers. Confirm or
   correct every assumption in docs/data-notes.md with evidence. List anything surprising.
2. Propose the extraction rules for each project × option: PV kWp (package names like "10.8kWp", module lines × Wp,
   else per-panel item quantity × assumed Wp), battery kWh (parse names, sum extensions/modules, handle Wh columns),
   wallbox yes/no + kW, heat pump yes/no + kW, inverter kW, roof type, scaffolding, brand. Show 10 tricky examples per
   rule and how the rule handles them. Wait for my OK.
3. List edge cases with a proposed decision for each: retrofits (existing PV/battery), battery-only offers, EV without
   wallbox, very large systems (>30 kWp), projects with no parts, duplicate/near-identical variants, options that
   differ only in battery size. Wait for my OK.
4. Implement engine/labels.py → engine/artifacts/expert_designs.parquet with one row per project × option, plus a
   primary-label flag (option 1 unless we decide otherwise) and per-project variant ranges (min/max PV and battery).
   Also engine/artifacts/catalogue.json: the real sizes each installer sells.
5. Validation: print 20 random projects with raw line items next to the extracted design so a human can spot-check.
   Write unit tests for the parsing rules (pytest) including the tricky examples.
6. Update docs/data-notes.md with the final rules and numbers, tick the Phase 1 tasks in docs/PLAN.md, commit on
   branch engine/labels.

Then propose (do not build yet) the Phase 2 model design in docs/engine-spec.md: features, chained PV → battery →
wallbox approach, baselines, similar-homes ranges, catalogue snapping, locks, physics checks, heat pump rules, and the
evaluation protocol (held-out by project, installer A→B transfer, variant-range hit rate, error analysis). Flag every
place where the data cannot support a learned decision and say what we do instead.
