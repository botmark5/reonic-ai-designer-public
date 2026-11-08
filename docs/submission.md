# Submission text (draft for Mark to paste)

Every number here is from `docs/pitch-facts.md`, where each one has its source and the words it may be said with.
Before pasting:
- Replace `<APP_URL>`; the passcode goes to the judges separately, never into this text.
- Lines marked **[if merged]** describe hero moments still being built tonight. All of them are merged (#89 /live, #103 /offer); keep each line if it works on the stage build, otherwise delete it.
- Line marked **[if TTS on]**: keep only if "Listen to your offer" plays audio on production.
- Lines marked **[if deployed]** are merged on main but were not on Vercel production on 8 Nov (rate limit): keep them only if production serves them (or the judges get the stage build).

---

## Reonic AI Designer

**Pitch.** A few facts about a home go in, from a planner's form or from a phone call our AI voice agent takes, and a complete energy-system design comes out: PV size, battery, wallbox and a heat pump option, sized the way this installer's own planners sized their signed offers. The planner sees why (a range, the reasons, similar homes the installer already built) and can change anything in plain words, such as "they're buying an EV next year", while the homeowner gets a link that explains the offer in plain language. We measured it on 315 past homes the engine never saw, and we say openly where it is only on par with a rule of thumb.

## The problem
In Reonic's words, planners "spend hours on every single design", and "the first credible offer often wins". Most of a design is the same judgement every time: how much PV for this consumption, whether a battery pays, whether a wallbox belongs in the offer. That judgement already exists in the installer's past offers. Nobody is using it.

## What we built
- **Design engine.** Python service with a chained model: heat pump rule → PV yes/no and size → battery yes/no and size (it sees the planned PV) → wallbox. It is learned from 1,994 offer options across 1,593 signed projects from two installers, parsed from the offers' line items. Every size snaps to a size the installer actually sells. Physics adds yield, self-consumption and autarky. **An LLM never picks a size.** Claude only turns the planner's words into input changes and turns engine facts into explanations.
- **Voice intake.** An ElevenLabs agent takes the site-visit call. It asks about existing solar first, collects the facts, reads them back, and a draft design lands in the planner's inbox before the caller hangs up.
- **Planner.** The draft with a 3D house on top and four system cards below. Each card shows its P10–P90 range, the reasons and similar past homes. The planner can lock any component or type a change; the chain re-plans the rest. When a planner overrides a size, the card says how it compares with the 40 most similar past homes ("Larger than 99 % of similar homes").
- **Reality check.** A page that shows one past home as two houses, the engine's design next to what the expert sold, and below them the evaluation numbers on held-out homes, live from the engine, including where it is only on par. The two houses are a picture of how the engine designs, not a test: it learned from that home too.
- **[if deployed] Site visit on the phone.** `/visit` is a one-thumb form for the installer at the house: only the address is required. "Build the design" lights up five real steps (found the house, built the 3D model, placed the panels, added battery, wallbox and heat pump, draft ready), and the draft lands in the planner inbox marked "From site visit". Same normalisation and engine as the call.
- **Typed intake.** `/intake` asks the voice agent's questions on screen and goes through the same normalisation as the call, so a typed draft and a called draft with the same facts are the same design.
- **The real house.** The planner types an address and presses **Find house**: Google Solar fills the roof limit, direction and pitch, and the house can sit in its real street. An uploaded floor plan is read by Claude into rooms for the Inside view; it is layout only and never changes a size. Panels can be added, removed and moved one by one; the engine's kWp stays.
- **The installer decides what the homeowner may change.** Before sending, the planner narrows the engine's own options (solar size, battery sizes, car charger, heat pump option). The homeowner's page shows only those, and the server rejects anything else.
- **Homeowner offer.** A share link with the 3D house, the system and a plain-language explanation they can read or listen to.

## How we meet Reonic's criteria

### 1. Technical depth: reproducing expert decisions on unseen projects
- **Protocol.** 315 held-out homes, split by customer, never used for training; model choices were made by cross-validation on the training part. For every metric we compare with the best of three rules of thumb (kWh ÷ 1,000, the installer's median per consumption band, the installer's kWp per MWh).
- **All homes.** Whole-project PV error 2.93 kWp against 3.85 for the best rule (24 % lower). The engine recognises add-on sales from the planner's inputs: on 62 add-on homes it proposes no new solar for 77 %, where rules of thumb manage 6 %. PV yes/no is right for 88 % against 82 %.
- **New systems (253 homes).** PV error 2.45 kWp against 2.64, as on the reality-check screen: slightly better than the best rule, a small margin. Every learner, hybrid and tuned variant we tried lands at 2.42–2.57 kWp. We hit the ceiling of what these inputs explain; the rest is roof size and customer wishes, which the data does not hold.
- **Calibrated ranges.** The expert's PV falls inside the engine's P10–P90 range for 82 % of new full systems, against a target of 80 %. Next to its proposal the engine offers one smaller and one larger alternative; for 66 % of new systems the expert's PV is within 1.5 kWp of one of these three options.
- **Battery.** Size error where both chose a battery is 2.42 kWh against 2.71, and the size is within one catalogue step for 56 % of homes against 51 %. Installers size the battery by PV, not by consumption, and the chain reproduces that.
- **Transfer.** Trained on one installer and tested on the other, PV size error is 2.95 against 3.03 kWp and 2.82 against 3.12 kWp. The margins are small and rest on one pair of installers.
- **Where it is not better.** PV within ±1.5 kWp: 40 % against 43 %. Battery yes/no over all homes: 88 % against 90 %. Wallbox yes/no: 72 % against 73 %, close to a coin flip without EV information.
- **The one question that matters most.** The data records existing solar for only 5 % of battery-only add-ons, so the voice agent and the planner form ask "Solar already on the roof?" first. As a what-if, with that question answered correctly, PV error over all homes would drop from 2.93 to 2.15 kWp. This is not an accuracy, because in our test the answer comes from the expert offer itself.

### 2. User fit
- **Planner: speed, control, never a black box.** Every number has a range, reasons and similar homes. Every component can be locked or changed in plain words, and the rest of the chain follows. Same inputs give the same design. When the engine is unreachable the app says "Offline estimate" instead of pretending.
- **Homeowner: plain language.** One link with their house in 3D and an explanation in plain words. **[if TTS on]** They can listen instead of read.

### 3. Business impact (measured, nothing invented)
- **6 clicks, 29 s** from the start of a scripted call to the homeowner link. 24.5 s of that is the call itself.
- **4.6 s** from the end of the call to a shared offer, including a plain-words change by the planner (3.8 s).
- A full design from the engine takes about half a second.
- This is machine time; the planner's own review comes on top. We did not measure minutes saved or win rate: every project in the data is a signed deal, so there are no lost offers to learn from.

### 4. Execution and demo
- The demo runs end to end on production: phone call → draft in the inbox → "buying an EV next year" → design adapts → compared with the real expert design and the metrics across 315 held-out homes → homeowner link.
- 413 engine tests and 419 web tests (main 5daaafc, 8 Nov; re-count right before submitting).
- The engine evaluation is reproducible from the repository, given Reonic's data.

## Best use of ElevenLabs
The phone call is the front door of the product. An **ElevenLabs conversational agent** takes the site-visit call. It asks about existing solar first, because that is the strongest signal we found in the data. It accepts how people actually talk ("we're a family of four", "about 4,800 kilowatt hours", "we're getting an EV in spring"), never invents a value and reads a summary back before it ends the call. A **server tool** hands the facts to the engine during the call, so the planner has a draft design before the caller hangs up. A **post-call webhook**, signed with HMAC, stores the transcript, the summary and the collected fields. **[if merged]** While the call runs, every new fact updates the planner's screen live: the house builds itself, and when the caller mentions the EV, the car drives in. **[if TTS on]** At the other end, the homeowner presses "Listen to your offer" and hears an explanation of their system in an ElevenLabs voice. **[if merged]** While it plays, the house walks through one day of sun, battery and car charging.

## NAP angle
- **UX.** One idea per screen. The planner sees a range and the reasons, not a score, and can override anything in plain words. Every page says honestly where its numbers come from, including "on par" and "Offline estimate". The light theme is tuned for a projector.
- **Originality.** The system does not ask an LLM to design a solar system. It learns the installer's own judgement from their signed offers, keeps PV, battery and wallbox as one chain, snaps to their catalogue, and checks a planner's override against the installer's own history. The phone call, the planner and the homeowner link run on the same engine.
- **Pitch.** One story in five minutes: a call comes in, a design appears, the planner says "they're buying an EV next year", the design adapts, and we show how close it is to the expert on homes it never saw, including where it is not better.

## How to try it
- Open `<APP_URL>`. The planner passcode is given to the judges separately.
- **Live call:** press "Play demo call" for the scripted call, then "End call and send draft", then "Open in planner".
- **Typed intake:** `/intake`, answer the questions, then "Open in planner".
- **Planner:** try "They are buying an EV next year", lock any component, or set "Solar already on the roof?" to Yes.
- **Reality check:** `/reality` shows example past homes next to the real expert design, and the held-out numbers below them.
- **Homeowner:** "Use this design", then "Send to homeowner", choose what the homeowner may change, "Copy homeowner link", then open the link.

## Known limits
- **PV size has hit the ceiling of these inputs.** On new systems the engine is only slightly better than the best rule of thumb (2.45 vs 2.64 kWp). Roof size and customer wishes are not in the data; roof capacity from Google Solar is an optional input that caps the size.
- **The existing-solar answer matters most**, and the data rarely records it. Without the answer the engine has to guess whether a home needs a new system or an add-on.
- **The wallbox is close to a coin flip** without EV information. The heat pump is offered as a customer option for gas and oil homes, never imposed. Experts added one in 11 of 24 candidate homes.
- **Installer A's PV sizes assume 450 W per panel**, because their offers list only panel counts.
- **Economics use placeholder prices.** Payback and savings are illustrations, not quotes.
- **Two installers only.** Transfer to a new installer works in our test, but it rests on one pair.
- **No win-rate or time-saved claim.** Every project in the data is a signed deal.
- **Learning sizes from every offer option** (Reonic's answer that every option is a valid design) is the model in production since 8 Nov 12:40 Munich (PR #127): size errors were slightly lower, but the expert's PV among our three options fell from 69 % to 66 % of new systems and the EV-owner example moved away from the expert.
