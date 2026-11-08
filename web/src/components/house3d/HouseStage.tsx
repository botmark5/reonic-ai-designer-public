"use client";
import dynamic from "next/dynamic";
import { Suspense, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { FloorPlan } from "../../lib/floorplan";
import type { DesignResponse, Home } from "../../lib/types";
import { cn } from "../../lib/utils";
import { House3D } from "./House3D";
import { InsideStage } from "./InsideStage";
import type { Zone } from "./insideRules";
import { modelReason, revealedFromKey, revealKey, stageRoof, staticWanted, tilesForced, tilesWanted } from "./stage";
import type {
  ComponentKey, House3DMode, RoofInput, StageControls, StageLocation, StagePanel, StageReveal, StageView,
} from "./types";

export interface HouseStageProps {
  design: DesignResponse;
  home: Home;
  /** Planner: exact sizes, Save image, editing. Homeowner: plain words. Default "homeowner". */
  mode?: House3DMode;
  /** Roof facts (e.g. `roofFromSolarResult(...)`); win over home.tilt_deg / orientation_deg. */
  roof?: RoofInput;
  /**
   * The real address. With it (and the tiles flag on) the outside is Google's photorealistic 3D city; without it,
   * or on any tile problem, the procedural house. /reality never passes one.
   */
  location?: StageLocation;
  /** Outside or the inside diorama. Omit and the stage shows its own Outside / Inside switch. */
  view?: StageView;
  /** Inside: where the parts start (default battery, inverter, wallbox in the garage; heat pump outside). */
  zones?: Partial<Record<ComponentKey, Zone>>;
  /** Inside: the planner moved a part to another zone. */
  onZonesChange?: (zones: Partial<Record<ComponentKey, Zone>>) => void;
  /** Drape the annual sunshine map on the roof. */
  sunMap?: boolean;
  /** Build-up for /live. Omit to show the whole design at once. */
  reveal?: StageReveal;
  /** Emphasise one part (e.g. the card the planner hovers). */
  highlight?: ComponentKey | null;
  /** The viewer clicked a part in the scene (null: clicked empty space / Esc). */
  onSelect?: (key: ComponentKey | null) => void;
  /**
   * "satellite": on the real street (tiles on, address known) the camera starts ~800 m above the city looking down
   * and glides to the house in ~3 s; the panels drop in after and `onTilesReady` fires at the end. Reduced motion:
   * no flight. No street (no key, no tiles, a failure): the model as always.
   */
  intro?: "satellite";
  /** Energy flow lines and sun rays: omit for the default (off in the planner, on elsewhere, with a toggle). */
  flows?: boolean;
  /** An uploaded floor plan (b-web): the Inside view draws its rooms and the parts snap into them. */
  floorPlan?: FloorPlan | null;
  /** Progress (the /visit "Building your design" steps). The real street's first tiles are on screen. */
  onTilesReady?: () => void;
  /**
   * The procedural model is the outside on screen, with why: "off" (street not enabled), "no key", "no location",
   * "static", or the street's failure ("tiles: slow", "placement: …", "model view" when the viewer chose it).
   */
  onFallbackShown?: (reason: string) => void;
  /** Panels on the roof (count), each time it changes: the model's, then the real roof's once the street shows. */
  onPanelsPlaced?: (count: number) => void;
  /** Equipment (inverter, battery, wallbox, heat pump) is on stage. */
  onEquipmentPlaced?: () => void;
  /**
   * The part the camera zooms to and features (controlled). Omit and a click on a part focuses it by itself; null:
   * the preset view. Clicking a part, Esc and clicking empty space report through `onSelect`.
   */
  focus?: ComponentKey | null;
  /** Stages with the same key share one orbit (e.g. two houses side by side on /reality). */
  cameraKey?: string;
  /** Controlled time of day in hours (6–22). Omit for the built-in slider; with it, the slider follows. */
  timeOfDay?: number;
  /** The viewer moved the time slider (only matters when timeOfDay is controlled). */
  onTimeOfDayChange?: (hours: number) => void;
  /** Planner may drag, add and remove panels (only places them; never changes the engine's kWp). */
  editable?: boolean;
  /** The planner moved, added or removed panels; null = back to the engine's layout (Reset). */
  onPanelsChange?: (panels: StagePanel[] | null) => void;
  /** Floating labels on the model (PV kWp, battery kWh), sized for a projector. */
  labels?: boolean;
  /** Which overlays to show. Default "full". */
  controls?: StageControls;
  /** Always the still image (slides, print). */
  static?: boolean;
  /** Camera fly-in on first render (default true; skipped with reduced motion or any input). */
  flyIn?: boolean;
  className?: string;
}

// the real outside only loads (with its tiles library) when it is actually used
const SiteStage = dynamic(() => import("../site3d/SiteStage").then((m) => m.SiteStage), { ssr: false });

const noop = () => () => {};
const TILES_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_TILES_KEY;
const TILES_FLAG = process.env.NEXT_PUBLIC_HOUSE_TILES;
/** SiteStage's tile fade-in. */
const FADE_MS = 500;
/** No street tiles this long after the street was asked for: the model stays (SiteStage's own timer is 6 s). */
const STREET_WATCHDOG_MS = 6500;

/**
 * The one 3D component pages mount. It picks the renderer (procedural house today; real 3D tiles outside and the
 * inside diorama as they land) and always falls back to the procedural house, so a page never depends on Google.
 * Props that a renderer does not support yet are accepted and ignored, so pages can wire them now.
 */
export function HouseStage({
  design, home, mode = "homeowner", roof, location, view, zones, onZonesChange, sunMap, reveal, highlight, onSelect, focus, intro, flows, floorPlan, onTilesReady, onFallbackShown, onPanelsPlaced, onEquipmentPlaced, cameraKey, timeOfDay,
  onTimeOfDayChange, labels, controls, editable, onPanelsChange, static: forceStatic, flyIn, className,
}: HouseStageProps) {
  const wanted = useSyncExternalStore(noop, () => tilesWanted(window.location.search, TILES_FLAG), () => false);
  const forcedStill = useSyncExternalStore(noop, () => staticWanted(window.location.search), () => false);
  const still = !!forceStatic || forcedStill;
  const at = location && Number.isFinite(location.lat) && Number.isFinite(location.lng) ? `${location.lat},${location.lng}` : null;
  // the address the real outside failed for (or the viewer switched away from): procedural until the address changes
  const [off, setOff] = useState<string | null>(null);
  const [ownView, setOwnView] = useState<StageView>("outside");
  const shownView = view ?? ownView;
  // the drawn model is the default (Mark: the photo 3D is too blurry, panels look like they float); the street is a
  // choice ("Street (beta)") wherever it is offered, and `?tiles=1` opens on it
  const forced = useSyncExternalStore(noop, () => tilesForced(window.location.search), () => false);
  const [streetFor, setStreetFor] = useState<string | null>(null);
  const chosen = forced || (!!at && streetFor === at);
  const available = wanted && !!TILES_KEY && !!at && !still;
  const tiles = available && chosen && shownView === "outside" && off !== at;
  const chooseStreet = (on: boolean) => {
    setOwnView("outside");
    if (on) { setStreetFor(at); if (off === at) { setOff(null); setFailReason(null); } }
    else setStreetFor(null);
  };
  // Inside mounts the first time it is shown and then stays (hidden while Outside shows)
  const insideOn = shownView === "inside";
  const [insideOpen, setInsideOpen] = useState(insideOn);
  if (insideOn && !insideOpen) setInsideOpen(true);
  // The procedural house stays on screen until the street's first tiles arrive (the street fades in over it), then
  // it unmounts. A fallback before that is invisible: the house was there all along.
  const [readyAt, setReadyAt] = useState<string | null>(null);
  const [settledAt, setSettledAt] = useState<string | null>(null);
  const ready = tiles && readyAt === at;
  const settled = ready && settledAt === at;
  // progress events: why the model is the outside, once it is on screen
  const [modelOn, setModelOn] = useState(false);
  const [failReason, setFailReason] = useState<{ at: string | null; reason: string } | null>(null);
  const fallbackReason = modelReason({
    outside: shownView === "outside", tiles, still, wanted, key: !!TILES_KEY, at,
    failed: failReason && failReason.at === at ? failReason.reason : null,
    chosen,
  });
  const cbs = useRef({ onTilesReady, onFallbackShown });
  useEffect(() => { cbs.current = { onTilesReady, onFallbackShown }; });
  useEffect(() => { if (modelOn && fallbackReason) cbs.current.onFallbackShown?.(fallbackReason); }, [modelOn, fallbackReason]);
  // the street is ready: at once, or (satellite intro) when the camera has arrived at the house
  const [arrivedAt, setArrivedAt] = useState<string | null>(null);
  const streetReady = intro === "satellite" ? tiles && arrivedAt === at : ready;
  useEffect(() => { if (streetReady) cbs.current.onTilesReady?.(); }, [streetReady]);

  // watchdog: the street's first tiles must arrive in time, whatever happens inside it (a chunk that never loads, an
  // auth error the tiles library only logs): the model stays and the progress events still get their answer
  useEffect(() => {
    if (!tiles || readyAt === at) return;
    const t = window.setTimeout(() => { setFailReason({ at, reason: "tiles: slow" }); setOff(at); }, STREET_WATCHDOG_MS);
    return () => window.clearTimeout(t);
  }, [tiles, readyAt, at]);

  useEffect(() => {
    if (!ready || settled) return;
    const t = window.setTimeout(() => setSettledAt(at), FADE_MS + 100);
    return () => window.clearTimeout(t);
  }, [ready, settled, at]);
  const overlays = controls !== "none" && controls !== "time";
  const switcher = view === undefined && overlays && !still && !reveal;
  // the view choices: Outside / Inside; with the street on offer, the outside splits into the model and the street
  const streetOn = tiles || (chosen && available && off !== at && shownView === "outside");
  const views = [
    ...(available
      ? [
          { id: "model", label: "3D model", on: shownView === "outside" && !streetOn, pick: () => chooseStreet(false) },
          { id: "street", label: "Street (beta)", on: shownView === "outside" && streetOn, pick: () => chooseStreet(true) },
        ]
      : switcher ? [{ id: "outside", label: "Outside", on: shownView === "outside", pick: () => setOwnView("outside") }] : []),
    ...(switcher ? [{ id: "inside", label: "Inside", on: shownView === "inside", pick: () => setOwnView("inside") }] : []),
  ];

  return (
    // className goes to the figure only (pages size it via [data-h3d-stage] descendant selectors)
    <div className="relative">
      {renderStage()}
      {(switcher || (available && shownView === "outside" && !still)) && (
        <div role="group" aria-label="View" data-h3d-ui className="absolute left-3 top-3 z-10 flex gap-1 rounded-full border border-border/80 bg-surface-1/85 p-1 shadow-[0_1px_2px_rgba(16,17,20,0.05)] backdrop-blur-md">
          {views.map((v) => (
            <button
              key={v.id}
              type="button"
              aria-pressed={v.on}
              title={v.id === "street" ? "Google's photo 3D of the street. A known limitation: blurry in places, panels approximate." : undefined}
              onClick={v.pick}
              className={
                "inline-flex h-7 items-center rounded-full px-3 text-[13px] font-medium outline-none transition-[background-color,color,transform] duration-150 active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-focus " +
                (v.on ? "bg-primary text-primary-ink" : "text-ink-body [@media(hover:hover)]:hover:bg-surface-2")
              }
            >
              {v.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );

  function renderStage() {
  const inside = insideOpen ? (
    <InsideStage
      active={insideOn}
      design={design}
      home={home}
      mode={mode}
      controls={controls === undefined || controls === "full"}
      zones={zones as Partial<Record<"battery" | "inverter" | "heatpump" | "wallbox", Zone>> | undefined}
      onZonesChange={onZonesChange}
      floorPlan={floorPlan}
      className={className}
    />
  ) : null;
  // the model stays mounted (hidden, paused) while Inside shows: edits, time and camera survive the switch
  const model = (
    <>
      <div hidden={insideOn}>
    <House3D
      design={design}
      home={home}
      mode={mode}
      roof={stageRoof(roof, location)}
      reveal={reveal}
      highlight={highlight}
      onSelect={onSelect}
      focus={focus}
      flows={flows}
      onShown={() => setModelOn(true)}
      onPanelsPlaced={onPanelsPlaced}
      onEquipmentPlaced={onEquipmentPlaced}
      cameraKey={cameraKey}
      editable={editable}
      onPanelsChange={onPanelsChange}
      timeOfDay={timeOfDay}
      onTimeOfDayChange={onTimeOfDayChange}
      labels={labels}
      controls={controls}
      static={still}
      flyIn={flyIn}
      className={className}
    />
      </div>
    </>
  );
  // same tree shape with and without the street, so a fallback never remounts the house
  return (
    <>
      {/* Inside, once opened, stays mounted (hidden, paused): unmounting its canvas tore out drei's <Html> labels
          mid-commit (the removeChild page error) and lost the parts' places */}
      {inside && <div hidden={!insideOn}>{inside}</div>}
      {!settled && model}
      {tiles && location && (
        <div className={settled ? undefined : cn("absolute inset-0", !ready && "pointer-events-none")} aria-hidden={ready ? undefined : true}>
          {/* its own boundary: the lazy street code never holds up the page or the model's updates */}
          <Suspense fallback={null}>
          <SiteStage
            apiKey={TILES_KEY!}
            location={location}
            design={design}
            panelsOn={revealedFromKey(revealKey(reveal)).panels}
            labels={labels}
            sunMap={sunMap}
            buttons={overlays}
            veil={false}
            onReady={() => setReadyAt(at)}
            onPanelsPlaced={onPanelsPlaced}
            intro={intro}
            onArrived={() => setArrivedAt(at)}
            onFallback={(reason) => {
              if (process.env.NODE_ENV !== "production") console.info("[HouseStage] real outside unavailable:", reason);
              setFailReason({ at, reason });
              setOff(at);
            }}
            onModelView={undefined}
            className={className}
          />
          </Suspense>
        </div>
      )}
    </>
  );
  }
}
