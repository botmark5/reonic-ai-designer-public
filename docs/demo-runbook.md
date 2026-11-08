# Demo runbook (5 minutes, stage server)

The demo runs from the **stage server `http://localhost:3123`** (a production build of the newest main on Mark's laptop, same engine, Supabase and voice agent as production). Production on Vercel (`<APP_URL>`, never in git) is at 21cc698 (#148) and takes no new deploys until the Vercel rate limit resets, so features merged after #148 (focus panel #141, the floor plan in the Inside view #150, Find house fixes) are on the stage build only.
Every engine number below was checked on the live engine on 2026-11-08 at 00:20 and again at 02:50 after PRs #60 and #61 (installer A's catalogue, the voice default).
Numbers for the pitch: `docs/pitch-facts.md`.

## T−30 min: pre-flight
1. Open `<APP_URL>/api/engine/health`. It should report the engine reachable, the key configured, and one /design served by the engine.
   If not, go to "Engine down" below.
2. If `PLANNER_PASSCODE` is set, sign in at `<APP_URL>/login` in the demo browser and keep that tab open.
3. Open four tabs in this order: `/live`, `/` (planner), `/reality`, and an empty tab for the offer.
4. On `/reality`, check that the headline numbers show. "Engine offline" means the engine is down. Numbers to expect: new systems 2.45 vs 2.64 kWp ("Better than rules"); Calibrated 82 %; top-3 66 %; what-if card 2.93 → 2.15 kWp (say "what-if", never "accuracy": the answer is derived from the expert offer in this test).
5. Real voice call only: HQ's test call must have landed in the planner inbox on production. If it has not, use the scripted call.
6. Phone: charged, hotspot ready, the ElevenLabs test-call link from `docs/voice-agent.md` open, volume up.
7. Backup video: `~/Downloads/REVIEW-ME/backup-v3.mp4` on the laptop desktop, offline, scrubbed to 0:00. v3 is recorded on a local production build of current main against the production engine and follows the final script with the scripted call (EV in the call, **Customer wants no battery**, /reality EV owner, send, Listen). It shows Reonic projects, so it is never committed.

## The final script (5 minutes, word for word; the EV comes up during the call)
Numbers are from the production engine on the morning of 8 Nov. Read them off the screen; if they differ, say the screen's number.
Real call: the caller says about €120 a month, which the app turns into about 4,100 kWh, so the draft is **10.35 kWp, 10 kWh, 11 kW wallbox** (hybrid engine since 12:40; voice, `/intake` and `/visit` drafts leave the electricity price to the engine's default; the planner's 0.32 €/kWh would give 10.8 kWp, so don't type a price on stage). Scripted call (fallback, says 4,800 kWh): **11.25 kWp, 10 kWh, 11 kW wallbox**. Both get a heat pump chip **Option · 10.5 kW**. The stage address has room for 222 panels, so Google's roof does not cap the solar.

| time | screen | do | expect on screen | say (word for word) |
|---|---|---|---|---|
| 0:00–0:20 | slide | Opening line. | | "Every installer's planners design the same kind of system again and again, by hand, for every home. The judgement is already in their signed offers. We turned those offers into a design engine, and the planner stays in charge." |
| 0:20–1:20 | `/live` | Call the agent from the phone (headset), playing the caller below. Point at the screen as facts arrive. | The fact checklist fills in, the house assembles, and at the EV answer the car drives in. At the end: "Draft design" and "In the planner's inbox for review". | Before dialling: "A homeowner calls. An ElevenLabs voice agent takes the site-visit call." While it runs (in the pauses): "It asks about existing solar first, because that is the strongest signal we found in the data." · "Every answer lands on the screen as it is said." · At the EV: "There's the car, and the wallbox is in the design already." |
| 1:20–1:40 | `/live` → planner | Click **Open in planner**. | "Drafted by AI from a call": the house on top, four cards below. **Solar 10.35 kWp** (scripted: 11.25), **battery 10 kWh**, **wallbox 11 kW**, heat pump **Option · 10.5 kW**. | "Before the caller hung up, the planner had a complete draft. Every size comes from the engine, learned from this installer's signed offers and snapped to sizes they actually sell. Claude never picks a size." |
| 1:40–2:05 | planner | Hover the Solar card (the roof lights up). Click the battery on the house: the camera zooms to it and its card is ringed; on the stage build its focus panel opens next to the house (**Want it?**, **Which size?**, **Where?**). Point at the range bar and the reasons. | P10–P90 range bar, reasons, similar homes. | "Not a black box: a range, the reasons, and similar homes this installer already built. The range holds the expert's choice for about 80 % of new systems." |
| 2:05–2:35 | planner | Click the example **Customer wants no battery**, or type it, then **Update design**. | "Updating…" (about 4 s), then the battery card shows the change **10 kWh → none**; solar and wallbox stay. | "The planner talks to it like a colleague and can override anything. PV, battery and wallbox are one chain: the rest is re-planned around the change." |
| 2:35–2:50 (only if ahead of time) | planner | Open **Roof size and direction**, set **Roof fits up to (kWp)** to 6. | **Solar 5.85 kWp**, battery stays off, wallbox on. | "Roof only fits 6 kWp? It snaps to the largest package that fits." |
| 2:50–3:50 | `/reality` | Click **Compare with expert** (or the pre-opened tab). Click **Large home**, then **EV owner**, then scroll to the tiles. | Large home: ours **10.35 kWp / 10 kWh**, the expert's **11.25 kWp / 10 kWh**, both **"Match"**. EV owner: ours **11.7 kWp / 9.8 kWh / 11 kW**, the expert's **10.8 kWp / 9 kWh / wallbox** (solar and wallbox "Match", battery "Different from the expert"). Tiles: **2.45 vs 2.64 kWp** ("Better than rules"), **77 % vs 6 %**, **Calibrated 82 %**, top-3 **66 %**. | "One past home: left our engine, right what the expert sold, here a large home where both match. And an EV owner: solar and wallbox match, the battery is a bit larger than the expert's. The engine learned from this home too, so this is a picture, not a test. The test is below: 315 homes it never trained on. On new systems it is slightly ahead of the best rule of thumb, 2.45 against 2.64 kilowatt-peak, and its range holds the expert's choice for 82 %. On add-on sales it proposes no new solar for 77 % of homes, where rules of thumb manage 6 %. Where it is only level, as for the battery and wallbox yes/no, we say so." |
| 3:50–4:05 | planner | Back: **Use this design**, then **Send to homeowner**: the panel **What the homeowner may change** opens (solar size, battery, car charger, heat pump option, prefilled from the engine's own options). Leave the defaults ("Your proposal is always shown. Untick what you don't want them to choose."), press **Copy homeowner link**, then **Open** in the toast. | "Design saved as the offer", "Homeowner link copied"; the offer opens and shows only the choices you allowed. | "The installer decides what the homeowner may change, and the homeowner gets a link." |
| 4:05–4:40 | `/offer/<token>` | Click **Listen to your offer**; let the house walk through the day. | The house, savings, the explanation; the clock moves through the day. | "Plain words for the homeowner. They can read it or listen, and the house shows their day: the sun on the roof, the house using it, the car charging." |
| 4:40–5:00 | slide | Close. | | "A phone call in, a reviewed design out in half a second, every size explained, and honest numbers on 315 homes it never trained on: 24 % less solar error than the best rule of thumb over all homes. Thank you." |

### Story order with the site visit (Mark's story, 8 Nov)
The installer fills **`/visit`** on the phone at the house (or the homeowner calls the voice agent) → the app finds the house from its address and satellite data → builds the 3D house → places the panels and products → proposes the plan → the installer tweaks it in the planner and sends it, choosing in **What the homeowner may change** what the homeowner may change → the homeowner's link offers only those choices.
To show it instead of the call (0:20–1:20): on the phone (or the laptop at phone width), open `/visit`, fill the Anna Weber facts below (address, name, no solar, € a month 120, 4 people, Planned EV 15000 km, Gas), tap **Build the design**, let the five steps light up, then **Open in planner**: **From site visit**, the same 10.35 kWp / 10 kWh / 11 kW draft. Say: "At the site visit the installer types a few facts on the phone. The app finds the roof from the address, builds the house, and the draft is in the planner before they leave the driveway." Address suggestions appear after a few letters (Places enabled 8 Nov).

### Caller persona for the real call (say these, in this order)
"Anna Weber, Musterstraße 80, München." · "No, no solar and no battery yet." · "We're a family of four, about 120 euros a month." · "**We're buying an electric car next year.**" (the agent assumes 15,000 km) · "Gas heating, the roof faces south." · confirm the summary.
If the call fails: **Play demo call** on `/live` (scripted, same story with 4,800 kWh), then **End call and send draft**, then **Open in planner**; carry on with the same script.
Second fallback, typed: **`/intake`** asks the voice agent's questions on screen ("Same questions as the voice agent"); answer as the persona, then **Open in planner**. Same draft as the real call (10.35 kWp, 10 kWh, 11 kW wallbox). Some answers take up to 30 s (the address looks up the roof), so prefer Play demo call when time is short.

### Example cases on /reality, by role
The two houses show the **shipped engine**, which learned from all past projects including these. Never call them held-out or a test; the held-out numbers are the tiles below the houses (#98, "One past home").
Values below were read overnight on 2026-11-08 on a local build and re-checked on the redeployed production engine on the morning of 8 Nov (`/heldout`, `/project`, `/project?answered=true`): all unchanged.

| button | ours (shipped engine, on screen) | expert | use on stage? |
|---|---|---|---|
| Typical home | 8.55 kWp, 9.2 kWh, no wallbox | 9.45 kWp; battery 5 or 10 kWh (2 options) | Yes: solar "Match", battery "Inside offered range". |
| EV owner | 11.7 kWp, 9.8 kWh, 11 kW wallbox | 10.8 kWp, 9 kWh, wallbox | Yes, as the second click. Solar and wallbox "Match", battery "Different from the expert" (hybrid engine; was "One size step away"). |
| Large home | 10.35 kWp, 10 kWh | 11.25 kWp, 10 kWh | **Yes: the hero case** (since the hybrid engine): both "Match". |
| Experts disagree | 9.0 kWp, 9.2 kWh | 6.75 · 12.15 kWp (2 options), 10 · 15 kWh | If asked: say "solar inside the offered range" (the battery shows "One size step away"); the expert offered two very different systems. |
| Heat pump case | no new PV, no battery, a wallbox, **12.5 kW heat pump offered as an option** | 12.5 kW heat pump only, no PV | Only if asked: the heat pump size is exactly the expert's; the engine adds a wallbox the expert did not sell. |
| Battery retrofit | "Not asked, as recorded": 9.9 kWp + 10 kWh, a new system. **"Planner answered (what-if)"**: no new PV + 5 kWh | 5 kWh battery-only add-on | Only as the what-if: switch to **Planner answered (what-if)** and say "if the planner answers 'solar already on the roof', it becomes the expert's battery add-on. That is why we ask it first." Never as accuracy. |

Live-engine checks you can repeat on the planner (production engine, 03:05). Base home: a new home in the planner with its defaults, 4,500 kWh, 0.32 €/kWh, H0 profile, gas heating, "Solar already on the roof?" = No.
The price and profile matter: the same 4,500 kWh sent without them gives 9.0 / 10.35 kWp, which is why older notes differ.
| change | design |
|---|---|
| none | 9.45 kWp, 9.2 kWh, no wallbox, heat pump option 10.5 kW |
| + electric car (15,000 km) | 10.8 kWp, 10 kWh, wallbox |
| + roof fits 6 kWp | 5.85 kWp, 7 kWh, wallbox |
| "Solar already on the roof?" = Yes, 8 kWp, instead of the above | battery retrofit, 5 kWh, no new PV |

## Hero moments: status and fallback per step
Updated as each pick merges. Until a row says **merged**, the click path above is what production shows.
The 3D house falls back by itself: with no Google 3D tiles (no key, slow or empty), the procedural house shows; when WebGL is missing or fails, the still image `web/public/models/house-fallback.png` shows. Two URL switches (since #78) work on any page with the house: add **`?static=1`** to show the still image without WebGL (use it when the projector stutters), or **`?tiles=0`** to force the procedural house when the real street misbehaves.

| screen | hero moment | status (night of 7–8 Nov) | if it misbehaves |
|---|---|---|---|
| `/live` | The house assembles while the call runs; "EV in spring" makes the car drive in. | **merged** (#89); the voice side is **merged** (#73: `update_facts` writes each answer to the call live, once HQ attaches the tool to the agent) | Tiles slow or missing: the procedural house assembles instead, automatically. WebGL slow: the fact checklist and draft still fill in; talk over the checklist. |
| planner | The house stage on top, card ↔ house highlight, old → new on changed cards. | **merged** (#68) | Tiles: hidden today, the procedural house shows (no Google key on production). WebGL fails: the still image shows and the cards work as before. |
| planner | The real house from Google 3D tiles with panels on the real roof, the **Outside / Inside** and **Sun map** toggles. | **merged** (#78 real street behind `?tiles=1`, #83 sun map on the real roof); shows only with the Google key on production | No key, or tiles slow: no toggles, the procedural house shows; `?tiles=0` forces it. Do not mention the real roof then. |
| `/reality` | Two houses side by side: ours and the expert's. | **merged** (#72), checked locally 04:40 | Tiles slow or missing: procedural houses. WebGL slow: the numbers and the example cases still work; point at those. |
| `/offer` | **Listen** walks the house through one day. | voice side **merged** (#86: Listen drives the house's day in timed segments; #88 a cached demo clip); /offer A **merged** (#103; Listen moves the clock through the day) | No audio: the text shows the same words. WebGL slow: the still image shows, the explanation still plays. |

## Fallbacks
| problem | what you see | do | say |
|---|---|---|---|
| **Voice call fails** (no answer, nothing on /live within 20 s) | "Waiting for a call" | Click **Play demo call** on `/live`, then **End call and send draft**, then **Open in planner**. The draft is **11.25 kWp, 10 kWh, wallbox**; the rest of the script is unchanged. | "Here is the same call, scripted, so we don't depend on the venue's phone signal." |
| **Engine down** | an **Offline estimate** badge on the planner and offer; "Engine offline" on `/reality` | Carry on: the planner still works on the built-in estimate and says so. Skip `/reality` and show deck charts 1 and 3 instead. | "When the engine is unreachable, the app falls back to a simple estimate and labels it. It never pretends." |
| **Wi-Fi down** | pages do not load | Switch to the phone hotspot, which takes about 30 s. If it is still down, play the backup video from the current step. | "Let me show you the recording while the network recovers." |
| **Audio missing** on the offer | text, no sound | Let the text show. It is the same explanation. | "The text version; audio plays the same words." |
| **Planner login appears** | the `/login` page | Type the passcode, which the presenter knows (it is not in this file). | |
| **Roof lookup empty** | no roof facts from the address | Expected: the Google Solar key is not set on production. Type the roof cap by hand, as in the optional step. | |

## Backup video: shot list (v3 follows "The final script"; this older list is kept for a re-take)
Record the hero version once the rows above say merged; for a row that is not merged, record what production shows.
1. `/live`, idle, then the incoming call: the fact checklist fills in, the house assembles, and the car drives in at "EV in spring" (60 s). Use the real call if it works, else **Play demo call** (the scripted call has the EV).
2. **Open in planner**: the house on top, the cards below. Hover the Solar card (the roof lights up), click the battery on the house (the camera zooms, its card is ringed; the focus panel opens on the stage build), open "N more reasons" (25 s).
3. If the Google key is on production: **Sun map** toggle, then **Inside** (the diorama), then back to **Outside** (15 s).
4. Refine: **They are buying an EV next year**, then the changed cards: Solar 9.9 → 11.25 kWp, Wallbox None → 11 kW (30 s). With the scripted call use **Customer wants no battery** instead.
5. Roof cap 6 kWp, then 5.85 kWp + 7 kWh (15 s).
6. Set "Solar already on the roof?" to Yes, 8 kWp: a battery retrofit, 5 kWh, no new PV (15 s).
7. `/reality`: the headline tiles (2.45 vs 2.64 kWp, 82 % "Calibrated"), the two houses side by side, then **Large home**, **EV owner** and **Experts disagree** (60 s). Keep the what-if card out of the shot or say "what-if".
8. **Use this design**, then **Send to homeowner** → **What the homeowner may change** (defaults) → **Copy homeowner link**, then **Open**: the offer page, scroll the house, click **Listen** and let the day play (60 s).
9. End card: the deck's headline chart (10 s).
