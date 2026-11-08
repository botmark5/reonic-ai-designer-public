# Reonic AI Designer

The design system for the AI Design module: the screens where an installer's planner gets a complete PV, battery, wallbox and heat-pump design from a few facts or one phone call, refines it, and checks it against what experts sold. It is built to sit inside Reonic, so it takes Reonic's own visual language (from reonic.com, November 2026) and adds one thing: a visible, honest mark for what the AI made.

## Who it is for

- **The planner** at an installation company. Writes several offers a day between site visits. Needs speed and full control, and fears a black box they cannot justify to a homeowner.
- **The homeowner** who receives the offer. Needs plain language and room to explore variants the installer allows, and fears being oversold.

Every screen favours one of them. Planner screens are dense and exact; homeowner screens are calm and explain.

## Voice

- Write like a senior planner talking to a colleague: short, concrete, in the trade's own units. "10.8 kWp because homes using 4,500 kWh with an EV usually got 9 to 11 kWp," not "Our AI optimised your solar."
- Always show the unit: kWp for PV, kWh for battery and consumption, kW for heat pump and wallbox, €/kWh for prices. Numbers use thin grouping (4,500) and one decimal for kWp.
- Say where a number came from: "214 similar homes from this installer," "assumed 450 W panels." An assumption is labelled, never hidden.
- Never say the AI decided. The engine proposes; the planner decides. Buttons say what happens: "Use this design," "Lock battery," "Send to homeowner."
- Homeowner copy drops jargon: "solar panels" not "PV," "battery" not "storage system," and says what changes for them in euros and percent.

## Visual foundations

- **Ground and neutrals.** Pages sit on `surface-0`, Reonic's warm off-white; cards on `surface-1` with a `border` hairline and `radius-md`. Neutrals are zinc with a faint cool bias. Separate with borders, not shadows; `shadow-pop` only for things that float (the live-call sheet, popovers).
- **One primary action.** The black pill (`primary` on `primary-ink`) appears once per view. Secondary actions are `surface-2` pills. Every button and badge is a pill (`radius-pill`).
- **Type.** Geist throughout, regular weight with tight tracking at display sizes (`display`, `h1`), semibold for section and card titles. Numbers use Geist Mono (`metric`, `data`) with tabular figures, so sizes line up. Noto Serif (`quote`) only for people's own words.
- **The AI mark.** Reonic draws "AI" with an amber-to-salmon gradient (`ai-amber` → `ai-orange` → `ai-salmon`). We use it only where the engine just produced something: the frame of a freshly generated design, the pulse of a live voice call, the small "Drafted by AI" badge. Text in that colour uses `ai-text`. If everything glows, nothing does.
- **Components have colours.** PV `comp-pv`, battery `comp-battery`, heat pump `comp-heatpump`, wallbox `comp-wallbox`, the same in every chart, flow line and icon. They differ in lightness as well as hue.
- **State is a shape plus a colour.** Confidence and validation use badges with a dot and a word: `success` (matches experts, high confidence), `warning` (unusual, assumption used), `critical` (outside every similar home, implausible). Never colour alone.
- **Changed values** after a refine get a brief `highlight` fill behind the number, then settle.
- **Layout.** 4px base, spacing tokens `space-1` to `space-12`. Planner view: a narrow input column on the left, the design in the centre, evidence (similar homes, ranges) on the right; it stacks to one column on mobile. Homeowner view: one column, generous spacing, one decision per section.
- **Motion.** Short and functional: values count up when a design arrives (300 ms), the AI frame draws once, the call pulse breathes while listening. Respect reduced motion.

## Iconography

Line icons at 1.5px stroke on a 24px grid (Lucide-style), coloured `ink` or the component's colour. No emoji, no illustrations of people. A component's icon is its silhouette: sun-panel for PV, battery cell for storage, fan for heat pump, plug for wallbox.

## Logo

No Reonic logo files were available, and this system does not redraw one. Use the product name in Geist, or Reonic's official assets if they provide them.

## What is in here

- **Tokens**: colours for both themes, type, spacing, radius, shadows.
- **Components**: Button, Badge, SystemCard (one proposed component with its size, range and reasons), ConfidenceRange (where a value sits among similar homes).
- **Not yet**: the energy-flow diagram, the live-call sheet, the homeowner explorer. They are designed in the mockups first.
