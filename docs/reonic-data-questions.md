# Data questions for Reonic (what would make the engine measurably better)

The engine's research (engine/RESULTS.md) shows that PV size has reached what the current inputs can explain:
~20 learners, rules, hybrids and tunings all land within 2.47–2.57 kWp MAE. The remaining error is information the data
does not contain. These are the questions, ordered by expected gain.

1. **More installers.** We have 2 installers / ~1,600 projects; Reonic serves 3,000+. Training on one installer already
   transfers to the other (PV MAE 2.9 vs 3.0 kWp for the band median), so more installers would very likely help.
   *Ask:* can the same export (status quo + offer line items) be shared for 10–50 more installers?
2. **Roof data of past projects.** Address or coordinates (or roof area, orientation, pitch) per project would let us
   look up roof capacity with the Google Solar API, as the live form already does, and learn "large roof → larger
   system" instead of only capping. *Ask:* is the address / geo position available, or a roof-planning export?
3. **Which offer option was signed.** *Answered by Niklas (Reonic) on 8 Nov:* not in the export, and there is no reliable
   proxy (option numbers only count up; a gap is a deleted option, not a rejection); every option is a valid planner's
   design. Done: the engine now trains on every option and also scores against the nearest option (PR #127).
4. **Existing PV on the roof.** Recorded for only ~5 % of battery-only offers; answering it lifts PV yes/no from 90 % to
   100 % on our test set. *Ask:* is it stored elsewhere (e.g. site-visit form), or can it be made a required field?
5. **Customer budget or financing.** Planners balance designs against what the homeowner can afford. *Ask:* is a budget,
   financing request or price sensitivity recorded anywhere?
6. **Prices.** The data has no prices, so savings/payback use placeholder assumptions. *Ask:* typical €/kWp, €/kWh battery
   and feed-in assumptions per installer (or offer totals), to replace the placeholders.

Not needed / not useful: public registries (Marktstammdatenregister: sizes without household data), foreign datasets
(Ausgrid, LBNL Tracking the Sun). Public load profiles (WPuQ, HTW Berlin) would only improve the physics, not the
expert-matching accuracy.
