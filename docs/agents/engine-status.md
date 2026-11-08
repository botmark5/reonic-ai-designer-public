# Engine status (updated by the engine agent at the end of each session)

## Sun 04:40 (night session, Mark's second agent; PR `engine/night-fixes`)
**Done (all additive, 393 + 4 tests green):**
- #66 physics flags calibrated on what the experts actually sold (training part, 1,046 new systems): PV yield / consumption
  info > 2.5 (p75), warn > 4.0 (~p96), error > 5.5 (p99); battery warn > 2.0 kWh per kWp (~p98). The old 2x / 3x cut-offs
  flagged 44 % / 13 % of expert designs. On `/design`, a `PV_OVERSIZED` warning becomes info when the 40 most similar past
  homes show the size is typical for that consumption. Finding behind it: homes under 2,000 kWh got a median 6 kWp and a
  battery in 100 % of cases, so the engine's 7.2 kWp + battery for a 1,600 kWh home IS the expert behaviour; "no battery"
  in a new system is a 4 % expert choice with no pattern in the inputs, so it stays a planner lock / add-on outcome.
  Table: `engine/RESULTS.md`, "Physics flags calibrated on expert practice".
- #47 `GET /project/{id}?answered=true`: `ours` built with `home.has_existing_pv` derived from the expert offer type
  (as the answered-mode evaluation does); response adds `answered` and `planner_answer`. Default unchanged. The /reality
  battery-retrofit case becomes a battery retrofit with it (what-if, never an accuracy).
- Alternatives (Mark's request): `pv.alternatives` and `battery.alternatives` are one smaller and one larger size around
  the proposal, sorted ascending, with shares. Top-3 metric unchanged (70 %); bracketed proposals 45 -> 77 %.

**Next:** deploy to Railway (`railway up` from the synced build folder), then re-check the runbook numbers on production.
**API changes:** see the end of docs/api.md (three additive entries dated 8 Nov).
**Blocking:** nothing.

## Sun 00:00
**Deployed:** the engine runs on **Railway** with a fixed URL (sent to Mark by DM, never in the repo). Same
`X-Engine-Key`. Claude calls work from Railway. The Cloudflare tunnel is the backup (its URL changes on restart).
Web: set `ENGINE_URL` in Vercel to the Railway URL.

**Done since the last update (all on main or in the PR named below):**
- #27 roof inputs: `home.roof_max_kwp` caps PV (whole 450 W panels, reason shown, lock above it flagged
  `ROOF_CAPACITY_EXCEEDED`); `home.roof_azimuth` (180 = south) and `home.roof_pitch` drive yield/autarky via PVGIS.
- #29 P10–P90 calibrated (conformal): contains the expert PV size in 79–80 % of locked-test projects (was 74–75 %).
- Mark's demo bugs: a typed 4,500 kWh is a real value at /design; an EV adds a wallbox and +1.3 to +1.8 kWp PV.
- Model-or-rule per yes/no decision, picked on training CV: wallbox = "EV -> wallbox" rule; battery in new systems =
  "always". The engine is never worse than the simple rule on CV.
- Battery size = mean of the classifier and the installer's kWh-per-kWp rule (full designs: within one catalogue step
  49 -> 54 %, MAE 2.69 -> 2.64 kWh on the locked test set).
- Physics uses PVGIS (EU JRC) yield per tilt x orientation and the real monthly split.
- Tested and NOT shipped: PV linear blend (CV +2 %, neutral on test, fewer exact package matches), roof type as an input
  (no gain), random forest / kNN / HistGB (not better than LightGBM).
- Before/after per improvement + error analysis: `engine/RESULTS.md`. Headline = new full systems; add-on sales separate.

**Next:** keep the Railway deploy in sync after each merge; answer `for:engine` issues.

**API changes (all additive, see the end of docs/api.md):** `home.has_existing_pv`, `home.roof_max_kwp`,
`home.roof_azimuth`, `home.roof_pitch`; response `options.heatpump`, `economics`, `physics.flags`, `battery.alternatives`.

**Blocking:** nothing. Human item: #35 (Vercel check fails on commits authored by Cala-rgb).
