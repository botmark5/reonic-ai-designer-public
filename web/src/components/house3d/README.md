# House3D

The customer's house as a softly coloured model (warm plaster, anthracite roof, green lawn; soft shadows, ambient occlusion) with the proposed system
on it. Colour appears only on the energy system: dark-glass panels, battery, heat pump, wallbox, and energy flows in
the AI gradient. A time-of-day slider runs a modelled sunny May day: the sun moves on its real arc, flows follow it
(noon: panels → house, battery, car; evening: battery → house; early morning: grid → house) with live kW and battery %.

## Usage

```tsx
import { House3D, roofFromSolarResult } from "@/components/house3d";

<House3D design={designResponse} home={home} mode="planner" />      // planner: exact sizes, "Save image"
<House3D design={designResponse} home={home} mode="homeowner" />    // /offer/[token]: plain words

// with Google Solar (GET /api/solar?address=…): real roof direction, pitch, panel cap and sun path for the location
<House3D design={r} home={home} mode="planner" roof={roofFromSolarResult(solar)} />
```

| Prop | Type | Notes |
|---|---|---|
| `design` | `DesignResponse` (`@/lib/types`) | What the engine returned. Excluded/null components are hidden. |
| `home` | `Home` | Roof: `roof_azimuth` / `roof_pitch` (the planner's fields) win, then the `roof` prop, then `orientation_deg` / `tilt_deg`, then 35° south; `roof_max_kwp` caps the panels drawn. `existing_pv_kwp` (unless `has_existing_pv` is false) puts the panels already there on the roof, so a battery retrofit shows its solar; they are drawn in a weathered tint and carry `existing:` ids, so flipping "solar already on the roof?" visibly swaps them for the engine's proposal (the proposal is new panels, not leftovers). `annual_kwh`, `ev_km_year` drive the modelled day. |
| `mode` | `"planner" \| "homeowner"` | Labels and tooltips. |
| `roof?` | `{ pitchDeg?, azimuthDeg?, maxPanels?, latitude?, longitude? }` | Overrides the home's roof. `roofFromSolarResult(result)` builds it from `/api/solar` (undefined when Google has nothing). |
| `static?` | `boolean` | Always show the still image (slides, print). |
| `flyIn?` | `boolean` | Short camera fly-in on first render (default `true`). |
| `className?` | `string` | Width comes from the parent; height follows the aspect ratio (4:3, 16:10 from `md`). |

It is a `"use client"` component and loads the canvas with `next/dynamic` (`ssr: false`), so it is safe in server
pages. Pass a new `design` object after a refine and only what changed animates.

## Behaviour

- **Design changes** (springs, interruptible): panels drop in row by row from the gutter and land with a slight bounce;
  battery modules (≈ 2.5 kWh each) stack in and the gauge springs to the state of charge; adding a wallbox drives the
  car in from the street, removing it drives the car out; the heat pump fan turns with its load.
- **Modelled day** (`energyDay.ts`): clear-sky PV on the real roof plane (NOAA sun position; Munich unless the roof
  gives a location), H0-like household load scaled to `annual_kwh`, PV-surplus car charging (1.4–3.7 kW), small
  heat-pump load, forecast-based battery charging, then the grid. Labelled "Sunny day in May, modelled" in the UI.
- **Camera**: fly-in (≈ 1.6 s; any drag, pinch or key skips it), presets Street / Roof / Garage (re-click resets).
- **Energy flow**: thin, quiet dashed lines and short sun rays. `flows` controls them; omitted, they start off in the
  planner (on for the homeowner and during a /live build-up) and an "Energy flow" toggle next to the presets switches them.
- **Click to focus**: click a part (panels, inverter, battery, wallbox or the car, heat pump) and the camera glides to it
  from the current angle with its info card in frame; click it again, click empty space, press Esc or pick a preset to
  glide back. `focus` (HouseStage / House3D) controls it from outside; `onSelect` reports clicks. While panel editing
  is on, a click on a panel picks it for editing instead.
  Vertical swipes scroll the page; the wheel zooms only with Ctrl/⌘.
- **Accessibility**: live panel rows are buttons (keyboard, hover, tap) that show size + the engine's first reason; a
  live region carries it for screen readers; the slider has a text value.
- **Reduced motion**: no fly-in, no dash motion, design changes and the sun apply instantly.
- **Still image** (`/models/house-fallback.png`, `-dark.png`: house and panels only) when WebGL is missing, data saver is
  on, the device has ≤ 2 cores, WebGL fails or `static` is set; also shown until the first 3D frame.
- **Performance**: ~6k triangles, one 2048² shadow map, contact shadows, GTAO ambient occlusion at half resolution.
  Measured on an Apple M5 (MacBook Air class) in Chrome at DPR 2 while the day plays: 60 fps, p95 frame 18 ms, no long
  tasks. Slower GPUs drop AO first, then DPR (2 → 1.5 → 1); monitoring starts after load.

## Files

`layout.ts` (panel placement), `sceneSpec.ts` (design → what is shown, labels), `energyDay.ts` + `sun.ts` (the day),
`spring.ts`, `solarRoof.ts`, `houseGeometry.ts` / `equipmentGeometry.ts` (procedural models; Blender was not
available), `Scene.tsx`, `AmbientOcclusion.tsx`, `Equipment.tsx`, `EnergyFlow.tsx`, `CameraRig.tsx`, `Tooltip.tsx`,
`House3D.tsx`. Tests: `npm test`.

Deck stills and the day recording (live engine designs, no mock): `node scripts/house/export-stills.mjs` from `web/`
(header of that file lists the options; output goes to the git-ignored `docs/deck/out/3d/`, `--upload` puts it on the
`data-v1` release). Portrait frames (narrower than 5:4) widen the field of view so the model keeps its width.

Regenerate the still images: render the component (light, then dark) with reduced motion and with equipment and flow
lines temporarily hidden, screenshot the model area at 1600×1000 and replace the two PNGs in `web/public/models/`.

### Floor plan in the Inside view (`floorPlan`)
- `floorPlan?: FloorPlan | null` (b-web's type in `lib/floorplan.ts`: metres, origin top-left, y down, bottom edge =
  front). Set: the Inside view draws the plan instead of the generic section: the ground floor as a plate with every
  room's walls extruded (1.1 m cutaway) and named, basement rooms on their own plate to the left, an outside strip along
  the front facade. Upper floors are not drawn (equipment never goes there). Rules: `floorPlanLayout.ts` (tested).
- The equipment zones snap into named rooms: basement → a basement room, else a utility room; garage → a garage room;
  outside → the front facade. A missing room becomes a labelled tile next to the house. Deep narrow rooms (a garage)
  take the parts along their long side wall. Parts drag anywhere on the plan and drop into the room under them; the
  zone pickers list the room names. Labels sit above the walls, staggered, so neighbours never overlap.

## HouseStage (mount this one)
`<HouseStage>` is the single 3D component pages mount. Today it renders the procedural house; real 3D tiles
outside (behind `?tiles=1` / `NEXT_PUBLIC_HOUSE_TILES=1`, needs `location`) and the inside diorama land behind the
same props. Props not yet supported by a renderer are accepted and ignored. Full prop list: `HouseStage.tsx`.
`/reality` never passes `location` (Reonic projects have no address; we never geocode Reonic data).

### Live today (procedural house)
- `reveal`: shell rises out of the board → roof settles → existing PV / new panels drop row by row → inverter (with
  the first panels) and battery modules stack in → car drives in with the wallbox → heat pump stands as a ghost for
  0.9 s, then solid. Energy only flows through parts already on stage. Omit `reveal` for the whole design at once.
- `highlight` / `onSelect`: emphasise a part from outside (tooltip + readout row); clicks in the scene or the
  readout report the picked part (null on empty space).
- `cameraKey`: stages with the same key share one orbit in house coordinates; whichever the viewer touched leads.
- `timeOfDay` / `onTimeOfDayChange`: controlled time; Play is hidden when controlled without a change handler.
- `labels`: always-on projector labels (Solar kWp, Battery kWh, Wallbox kW, Heat pump kW).
- `controls`: "full" (time bar + readout UNDER the model), "minimal" (camera presets), "none".

### Real outside (site3d, behind a flag)
- **The drawn model is the default** (Mark: the photo 3D is blurry, panels looked like they float). With the street
  offered, the view switcher reads "3D model | Street (beta) | Inside" (a lone pill pair where there is no switcher);
  `onFallbackShown("model")` reports the default. `?tiles=1` opens on the street.
- Offered with `?tiles=1` or `NEXT_PUBLIC_HOUSE_TILES=1`; needs `location` and `NEXT_PUBLIC_GOOGLE_MAPS_TILES_KEY`
  (referrer-locked: production, localhost:3123, localhost:3125). `?tiles=0` forces it off, `?static=1` forces the still.
- Google photorealistic 3D tiles re-centred on the address (+x east, −z north, like the model). Panels come from
  `/api/solar/panels` (d-voice): each roof segment sits at Google's plane height + one geoid offset calibrated by
  rays onto the photogrammetry (low quartile of 9 rays per segment, median over segments, rejected if implausible).
- Falls back to the procedural house (silently, once per address) on: no key, no location, placement not ok,
  tile error before the first tile, no tiles within ~6 s, a crash. "Model view" switches by hand.
- The procedural house stays on screen while the street loads (no "Loading" veil); the street fades in over it on its
  first tiles and the house unmounts ~0.6 s later. A fallback before that is invisible, so the env flag is safe to set.
- Progress events (the /visit "Building your design" steps), on HouseStage: `onTilesReady()` (street's first tiles),
  `onFallbackShown(reason)` (the model is the outside: "off", "no key", "no location", "static", or the street's
  failure), `onPanelsPlaced(count)` (model's count, then the real roof's), `onEquipmentPlaced()`. Each fires once per
  new value. A HouseStage watchdog (6.5 s) falls back even if the street code never answers.
- The camera looks at the new panels' centroid from the side their roof faces (a face seen edge-on hid them), and
  each face's panels are raised together onto the photogrammetry (upper quartile of the gap, ≤ 3 m) so none are buried.
  No energy flows on the street; with `labels` the Solar tag and product chips show.
- `intro="satellite"` (HouseStage): on the real street the camera waits ~800 m above the house looking down (until its
  tiles are sharp, ≤ 2.5 s after the first ones), then glides down to the house framing (~2 s); the panels, Solar tag
  and chips appear after it arrives, and `onTilesReady` fires then. Grabbing the camera mid-flight lands it. Reduced
  motion: no flight. No street: the model as always.
- Google attribution is always visible bottom-left. `reveal.panels` drops the panels row by row; `labels` shows chips.
- f-hero extras: `reveal.warm` (windows glow), heat pump shown as a permanent ghost when only offered
  (`design.options.heatpump.available`) and `reveal.heatpump` is on.
- Sun map (`sunMap` prop, or the "Sun map" button when omitted): d-voice's `/api/solar/layers` image draped on every
  tile surface by a world-position shader patch (chained with the tiles fade shader), fetched for the panels' centre
  so both line up; legend top-left. Procedural house: no sun map (the flux is real data for the real roof).

### Inside (view="inside", or the Outside / Inside switch when `view` is omitted)
- A section model: basement (sunk), garage, outside wall. The planner drags battery, inverter, heat pump and wallbox
  along the wall; allowed zones tint in the part's colour while dragging; a drop snaps to the nearest free slot or
  springs back with the reason ("The heat pump needs outside air."). Rules: `insideRules.ts` (pure, tested).
- Accessible twin: a zone picker per part under the model (disabled options = not allowed), live status line.
- `onZonesChange(zones)` reports the planner's choice. Labels sit on the floor in front of each part (hidden < sm).
- kWp sizes keep two decimals (11.25, not 11.3). Offered-only heat pump gets an "option N kW" label.
- drei `Html` under React 19: the first instance in a canvas can lose its root; both scenes mount a hidden placeholder first.

### Panel editing (planner, `editable`)
- Click (or grab) a panel: one amber outline with round corner handles; the energy flows hide while a panel is
  picked. Drag: the panel follows the pointer 1:1 (grab offset kept), one translucent ghost marks the free spot it
  snaps to on release. Drops and Add only take spots touching the array (no islands). A move moves only that
  panel; Remove fills the hole with the outermost panel of the shorter side (one panel; existing panels never move). Toolbar bottom-left: "Placed N of M" (warning colour when N ≠ M), Add (next to the picked one,
  spills to the garage), Remove (or Delete / Backspace), Reset. Escape lets go. Camera orbit pauses while dragging.
- Placement only: M is the engine's panel count and never changes. `onPanelsChange(panels)` reports
  `{id, segment (0 main, 1 garage), u, v, portrait}`; Reset sends []. Off during a reveal. Rules: `panelEdit.ts`.
