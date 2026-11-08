# Pitch deck: plan, slide by slide, with the script

Draft deck (11 slides, Reonic AI Designer design system, 16:9): private Claude Slides artifact
(private Claude artifact) (Mark's account; share or export to PDF/PPTX from its Share menu).
Every number on a slide is a **Safe** or **Caveat** row of `docs/pitch-facts.md`, with the caveat on the slide. Speaker notes
are in the deck; they repeat the lines of `docs/demo-runbook.md`, so the deck and the demo say the same thing.

The brief (p. 8) asks the deck to cover **the problem, the solution, how we evaluated it, and the value for installers and
homeowners**. The four criteria weigh equally: technical depth, user fit, business impact, execution and demo.

## Running order (5 minutes: 2 slides, then the live demo, then 7 slides in 2 minutes, or the deck alone in 5)

| # | slide | one message | numbers on it (source) | criterion served |
|---|---|---|---|---|
| 1 | Cover | Designs a home energy system the way your planners do. | 315 held-out homes | – |
| 2 | The problem | Planners "spend hours on every single design"; "the first credible offer often wins". The judgement exists in past offers; nobody uses it. | quotes = brief p. 3, 5 | business impact |
| 3 | What we built | One engine, three doors: voice call → planner → homeowner link; the reality check as the fourth screen. The engine decides every size; Claude never picks one. | – | user fit, execution |
| 4 | How it decides | One chain, not three guesses: heat pump rule → PV yes/no + size → battery (sees the PV) → wallbox; new-vs-add-on first; catalogue snapping; physics. | 1,994 options, 1,593 projects, 2 installers, 20 hand-checked | technical depth |
| 5 | Not a black box | Range (82 % coverage), reasons, 5 similar homes, one smaller + one larger alternative (top-3 holds the expert's PV within 1.5 kWp for 66 % of new systems, on screen), every override validated, deterministic. | pitch-facts §6, RESULTS round 3 | user fit (planner) |
| 6 | Measured on 315 homes | Protocol + three bars: whole-project solar error 2.93 vs 3.85 kWp (−24 %); add-ons "no new solar" 77 vs 6 %; PV yes/no 88 vs 82 %. | pitch-facts §2, §5 (all without the solar answer) | technical depth |
| 7 | The honest half | New systems: 2.45 vs 2.64 kWp (slightly better, small margin; screen badge "Better than rules"); within ±1.5 kWp 40 vs 43 % (below); coverage 82 %; top-3 66 % (new systems); battery size 2.42 vs 2.71 kWh (all homes), within one size 57 vs 46 % (new systems); transfer 2.95/2.82 vs 3.03/3.12. Ceiling 2.47–2.57 across every learner. | pitch-facts §2, §4–7 | technical depth |
| 8 | What the data taught us | New vs add-on is the decision that matters; consumption does most of the work and the solar question would be worth most (what-if 2.93 → 2.15); experts do not size for maximum return (2.77 vs 2.49) and size batteries by PV; small homes get a full system (about 7–8 kWp + battery) on purpose, like the experts (median 7.2 kWp for 1,500–2,500 kWh, n = 109). | RESULTS "Three strongest findings", round 2, "Physics flags calibrated" | technical depth, originality |
| 9 | Known limits | Wallbox 72 vs 73 %; battery yes/no 88 vs 90 %; 450 W assumption; two installers; placeholder prices; minutes saved and win rate not measured. Biggest lever = new inputs (roof, the solar question). | README Known limits, pitch-facts "Don't say" | honesty (all four) |
| 10 | Value | 29 s call → link (6 clicks); 4.6 s call end → shared offer; 0.5 s per design. Installer / homeowner / Reonic columns. | pitch-facts §8 | business impact |
| 11 | Close | The five-step demo story and the closing line. | 22 %, 315 | execution and demo |

## Script (what to say, 20–40 s per slide)

1. **Cover (0:00–0:20).** "Planners rebuild the same system from scratch for every home. We let the installer's own past
   offers draft it, and the planner stays in charge."
2. **Problem.** Read the two quotes as Reonic's words. "Most of a design is the same judgement every time. That judgement
   already exists in the installer's past offers. Nobody is using it."
3. **What we built.** "One engine, three doors. A voice agent takes the call, the draft lands in the inbox, the planner
   refines it in plain words, the homeowner gets a link. The engine decides every size; Claude never picks a size."
   → go to the live demo here (runbook click path), come back at slide 6.
4. **How it decides.** "The decisions are coupled, so the model is a chain: the battery sees the PV, the PV sees the total
   demand with the EV and the heat pump. It is learned from 1,994 offer options of two installers, and every size snaps to
   what the installer sells. Before the chain, one decision matters most: new system or add-on."
5. **Not a black box.** "Every number comes with a calibrated range, the reasons from the model itself, the five most
   similar homes the installer already built, and one smaller and one larger size. An override is checked against 40
   similar homes."
6. **Measured.** "Every number here comes from 315 homes the engine never saw, split by customer, against the best of three
   rules of thumb. Over all homes the whole-project solar error is 24 % lower, because the engine recognises add-on sales:
   no new solar for 77 % of add-on homes, where rules manage 6 %."
7. **Honest half.** "On new systems we are slightly better than the best rule, 2.45 against 2.64 kWp, a small margin. On exact
   size, within 1.5 kWp, we are below the rule. The gains are the yes/no decisions, the ranges that hold the expert's
   choice 82 % of the time, and the alternatives: the expert's size is among our three options for 66 % of new systems."
8. **Findings.** "Four things experts do that no textbook says." Read the four tiles. For the 2.15 kWp: "if the planner
   answers the solar question; in our test that answer comes from the expert offer, so it is a what-if, not an accuracy."
9. **Limits.** "Wallbox is a coin flip without EV information. We never propose 'no battery' for a new system, because
   96 % of new systems in the data have one. We did not measure minutes saved or win rate: every project in the data is a signed deal."
10. **Value.** "From the start of a call to the homeowner link: 29 seconds and 6 clicks. The planner's review comes on top.
    Junior planners design like the installer's own history; homeowners see sizes from homes like theirs."
11. **Close (last 20 s).** "One engine for the planner, the homeowner and the phone call: a reviewed draft in half a
    second, every size explained, 24 % less solar error than the best rule of thumb. Measured on 315 homes it never saw."

## Rules for the deck (from `docs/pitch-facts.md`)
- Never "X % accurate" without the metric and the comparison. Never "beats the experts" or "matches the experts".
- Answered-mode numbers (2.15 kWp, 97 %, add-on 87 %) only as a **what-if**, never as accuracy; they are on slide 8 only.
- No time saved, no win-rate uplift, no payback as fact, no project ids, no installer ids, no single real project's numbers.
- Say "best rule of thumb", not "a baseline". Say "level" for a tie.

## Still to do before the pitch
- Mark: export the deck (Share → Export) once the numbers are frozen at 11:00; put the PDF as `docs/pitch.pdf` or link it in the README.
- Slide 6 chart, if a chart image is preferred to the painted bars: `docs/deck/out/1_pv_error_new_vs_addons.png`
  ("22% less PV error than the best rule; on par with it on new systems": all homes 2.93 vs 3.85, new 2.45 vs 2.64,
  add-ons 2.15 vs 4.06), optionally with `5_add_on_sales.png` (77 vs 6, 69 vs 69, 74 vs 77). Both are on data-v1 as `deck_<name>`.
  `3_existing_pv_question.png` is the what-if (answered mode): slide 8 only, never slide 6.
- Rehearse twice with the runbook; the deck takes 2:30 without the demo, 5:00 with slides 1–3 and 6–11 around it.
- If engine PR #82 is on production, slide 8's fourth tile ("small homes get a full system on purpose") can also be shown
  live (hybrid engine): a 1,600 kWh home gets 7.2 kWp + 5 kWh and the flags say "most of the yield is fed in", not "implausible".
