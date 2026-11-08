"use client";
import type { RootState } from "@react-three/fiber";
import { ArrowDown, ArrowUp, Pause, Play } from "lucide-react";
import dynamic from "next/dynamic";
import { Component, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { DesignResponse, Home } from "../../lib/types";
import { cn } from "../../lib/utils";
import { PRESETS, type Preset, type PresetRequest } from "./CameraRig";
import { activeFlows, dayInputFrom, sampleDay, simulateDay, type Day } from "./energyDay";
import type { Pointer } from "./Equipment";
import { useReducedMotion, useThemeName } from "./hooks";
import { roofPlanes } from "./houseGeometry";
import { getPalette } from "./palette";
import { chooseRenderMode, detectEnv, type RenderMode } from "./renderMode";
import { buildSceneSpec, type CompKey } from "./sceneSpec";
import { MAY_DAY, type Place } from "./sun";
import { revealedFromKey, revealFlows, revealKey } from "./stage";
import { addPanel, fullGrid, movePanel, removePanel } from "./panelEdit";
import type { PanelSlot } from "./layout";
import type { PanelEditing } from "./Equipment";
import type { House3DMode, RoofInput, StageControls, StagePanel, StageReveal } from "./types";

const Scene = dynamic(() => import("./Scene"), { ssr: false });

/** Still images of the house with panels only (no other equipment), so they never show something the offer lacks. */
export const FALLBACK_IMAGE = { light: "/models/house-fallback.png", dark: "/models/house-fallback-dark.png" } as const;

export interface House3DProps {
  design: DesignResponse;
  home: Home;
  mode: House3DMode;
  /** Roof facts that override home.tilt_deg / orientation_deg, e.g. `roofFromSolarResult(await /api/solar)`. */
  roof?: RoofInput;
  /** Always show the still image (slides, print). */
  static?: boolean;
  /** Short camera fly-in on first render (default true; skipped with reduced motion or any input). */
  flyIn?: boolean;
  /** Emphasise one part from outside (e.g. the planner card under the pointer). */
  highlight?: CompKey | null;
  /**
   * Energy flow lines and sun rays. Omit: off in the planner, on for the homeowner, and a toggle ("Energy flow")
   * next to the camera presets lets the viewer switch them.
   */
  flows?: boolean;
  /** The house is on screen (first 3D frame, or the still image). */
  onShown?: () => void;
  /** Panels on the roof (count of all panels drawn), each time the count changes while shown. */
  onPanelsPlaced?: (count: number) => void;
  /** Equipment (inverter, battery, wallbox, heat pump) is on stage; fires again when the set changes. */
  onEquipmentPlaced?: () => void;
  /** The viewer picked a part in the scene or the readout (null: picked nothing / clicked empty space / Esc). */
  onSelect?: (key: CompKey | null) => void;
  /**
   * The part the camera zooms to and features (controlled). Omit and a click on a part focuses it by itself; null:
   * the preset view. Clicking a part, Esc and clicking empty space report through `onSelect`.
   */
  focus?: CompKey | null;
  /** Controlled time of day in hours (6–22). Omit and the slider keeps its own time. */
  timeOfDay?: number;
  /** The slider or Play moved the time (with timeOfDay controlled, apply it to see it move). */
  onTimeOfDayChange?: (hours: number) => void;
  /** /live build-up; omit to show the whole design. */
  reveal?: StageReveal;
  /** Always-on labels (PV kWp, battery kWh...) for a projector. */
  labels?: boolean;
  /** "full" (default): time bar and readout under the model. "minimal": camera presets only. "none": the model alone. */
  controls?: StageControls;
  /** Stages with the same key share one orbit. */
  cameraKey?: string;
  /** Planner may move, add and remove panels. Only placement: the engine's kWp never changes. */
  editable?: boolean;
  /** The planner's layout; null = back to the engine's layout (Reset). */
  onPanelsChange?: (panels: StagePanel[] | null) => void;
  className?: string;
}

/** If WebGL fails after all (context limit, blocked GPU), show the still image instead of breaking the page. */
class SceneBoundary extends Component<{ onError: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onError();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

const PRESET_LABEL: Record<Preset, string> = { street: "Street", roof: "Roof", garage: "Garage" };
const DOT: Record<CompKey, string> = {
  pv: "bg-comp-pv", inverter: "bg-comp-pv", battery: "bg-comp-battery", wallbox: "bg-comp-wallbox", heatpump: "bg-comp-heatpump",
};

const noop = () => () => {};
function useRenderMode(forceStatic: boolean): RenderMode {
  const auto = useSyncExternalStore(noop, () => chooseRenderMode(detectEnv()), () => "static" as const);
  return forceStatic ? "static" : auto;
}

const DAY_START = 6;
const DAY_END = 22;
const START_HOUR = 12.5;
const PLAY_SECONDS = 14; // a whole day
const UI_EVERY = 1 / 15; // s between React updates while playing

const pill =
  "inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium outline-none transition-[background-color,color,transform] duration-150 " +
  "active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface-0";
const glassPanel = "rounded-lg border border-border/80 bg-surface-1/85 backdrop-blur-md shadow-[0_1px_2px_rgba(16,17,20,0.05)]";

const clock = (h: number) => {
  const m = Math.round(h * 60);
  return `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};
const kw = (x: number) => `${(Math.abs(x) < 0.05 ? 0 : x).toFixed(1)} kW`;

/**
 * The customer's house as an architectural model with the proposed system on it, a modelled sunny day and the
 * energy flowing through it. Planner mode shows exact sizes and "Save image"; homeowner mode uses plain words.
 */
export function House3D({
  design, home, mode, roof, static: forceStatic = false, flyIn = true, highlight = null, onSelect, focus, flows: flowsProp, onShown, onPanelsPlaced, onEquipmentPlaced, timeOfDay,
  onTimeOfDayChange, reveal, labels = false, controls = "full", cameraKey, editable = false, onPanelsChange, className,
}: House3DProps) {
  const theme = useThemeName();
  const reduced = useReducedMotion();
  const [failed, setFailed] = useState(false);
  const renderMode = useRenderMode(forceStatic || failed);
  const palette = useMemo(() => getPalette(theme), [theme]);
  const baseSpec = useMemo(() => buildSceneSpec(design, home, mode, roofPlanes, roof), [design, home, mode, roof]);
  // planner edits of where the panels sit; a new design (another layout) starts from the engine's layout again
  const layoutKey = baseSpec.layout.slots.map((s) => s.id).join(",") + "|" + baseSpec.roof.pitchDeg;
  const [edited, setEdited] = useState<{ for: string; slots: PanelSlot[] } | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const editedSlots = edited?.for === layoutKey ? edited.slots : null;
  const spec = useMemo(
    () => (editedSlots ? { ...baseSpec, layout: { ...baseSpec.layout, slots: editedSlots, placed: editedSlots.length } } : baseSpec),
    [baseSpec, editedSlots],
  );
  const grid = useMemo(() => fullGrid(roofPlanes(baseSpec.roof.pitchDeg)), [baseSpec.roof.pitchDeg]);
  const place: Place = useMemo(
    () => ({ ...MAY_DAY, lat: roof?.latitude ?? MAY_DAY.lat, lon: roof?.longitude ?? MAY_DAY.lon }),
    [roof?.latitude, roof?.longitude],
  );
  const day: Day = useMemo(() => simulateDay(dayInputFrom(spec, design.design, home, place)), [spec, design, home, place]);

  const controlled = typeof timeOfDay === "number" && Number.isFinite(timeOfDay);
  const [ownHour, setOwnHour] = useState(START_HOUR);
  const hour = controlled ? Math.min(DAY_END, Math.max(DAY_START, timeOfDay)) : ownHour;
  const [playing, setPlaying] = useState(false);
  const latest = useRef({ controlled, onTimeOfDayChange, onSelect });
  useEffect(() => { latest.current = { controlled, onTimeOfDayChange, onSelect }; });
  const setHour = useCallback((h: number) => {
    if (!latest.current.controlled) setOwnHour(h);
    latest.current.onTimeOfDayChange?.(h);
  }, []);
  const canPlay = !controlled || !!onTimeOfDayChange;
  const moment = useMemo(() => sampleDay(day, hour), [day, hour]);
  const rk = revealKey(reveal);
  const shownParts = useMemo(() => revealedFromKey(rk), [rk]);
  const flows = useMemo(() => revealFlows(activeFlows(moment), shownParts), [moment, shownParts]);

  const [preset, setPreset] = useState<PresetRequest>({ preset: "street", n: 0 });
  const [ownFlows, setOwnFlows] = useState<boolean | null>(null);
  // a /live build-up keeps its flows (they are part of the story); otherwise the planner starts quiet
  const flowsOn = flowsProp ?? ownFlows ?? (mode !== "planner" || !!reveal);
  const [hovered, setHovered] = useState<CompKey | null>(null);
  const [selected, setSelected] = useState<CompKey | null>(null);
  const [ready, setReady] = useState(false);
  const [inView, setInView] = useState(true);
  const figure = useRef<HTMLElement>(null);
  // pause rendering while scrolled out of view
  useEffect(() => {
    const el = figure.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setInView(e.isIntersecting), { rootMargin: "120px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const three = useRef<RootState | null>(null);
  const shown = (k: CompKey | null) => (k && spec.components[k].visible ? k : null);
  // click to focus: the controlled `focus`, else the part the viewer clicked
  const focused = shown(focus !== undefined ? focus : selected);
  const active = shown(hovered) ?? shown(highlight) ?? focused;
  const selectedRef = useRef<CompKey | null>(null);
  const select = useCallback((k: CompKey | null) => {
    selectedRef.current = k;
    setSelected(k);
    latest.current.onSelect?.(k);
  }, []);

  // Esc zooms back out of a focused part (not while typing, not while a panel is picked: that Esc lets go of it)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !selectedRef.current) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      select(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [select]);

  // never leave the page with a pointer cursor
  useEffect(() => () => { document.body.style.cursor = ""; }, []);

  // play the day: time runs from now to 22:00 in ≤ 14 s; React only updates ~15×/s
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    let acc = 0;
    let h = hour >= DAY_END - 0.01 ? DAY_START : hour;
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      h = Math.min(DAY_END, h + (dt * (DAY_END - DAY_START)) / PLAY_SECONDS);
      acc += dt;
      if (acc >= UI_EVERY || h >= DAY_END) { acc = 0; setHour(h); }
      if (h >= DAY_END) { setPlaying(false); return; }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- start from the hour at the moment play was pressed
  }, [playing]);

  const pointer = useMemo<Pointer>(() => ({
    onOver: (k) => { setHovered(k); document.body.style.cursor = "pointer"; },
    onOut: (k) => { setHovered((h) => (h === k ? null : h)); document.body.style.cursor = ""; },
    onTap: (k) => select(selectedRef.current === k ? null : k),
  }), [select]);

  const onReady = useCallback((state: RootState) => {
    three.current = state;
    state.gl.domElement.addEventListener("webglcontextlost", () => setFailed(true), { once: true });
    requestAnimationFrame(() => requestAnimationFrame(() => setReady(true)));
  }, []);

  const saveImage = useCallback(() => {
    const s = three.current;
    if (!s) return;
    s.gl.render(s.scene, s.camera); // draw now, so the buffer is current without preserveDrawingBuffer
    const a = document.createElement("a");
    a.href = s.gl.domElement.toDataURL("image/png");
    a.download = "house-design.png";
    a.click();
  }, []);

  const show3d = renderMode === "3d";

  // progress events (the /visit "Building your design" steps): on screen, panels placed, equipment placed
  const events = useRef({ onShown, onPanelsPlaced, onEquipmentPlaced });
  useEffect(() => { events.current = { onShown, onPanelsPlaced, onEquipmentPlaced }; });
  const onScreen = show3d ? ready : true;
  const comps = spec.components;
  const panelsOnRoof = onScreen && comps.pv.visible && shownParts.pv ? spec.layout.slots.length : 0;
  const equipmentKey = onScreen
    ? [
        comps.inverter.visible && shownParts.inverter && "inverter",
        comps.battery.visible && shownParts.battery && "battery",
        comps.wallbox.visible && shownParts.car && "wallbox",
        comps.heatpump.visible && shownParts.heatpump && "heatpump",
      ].filter(Boolean).join(",")
    : "";
  // each fires once per new value (the still image then the first 3D frame do not repeat it)
  const sent = useRef({ shown: false, panels: 0, equipment: "" });
  useEffect(() => {
    if (onScreen && !sent.current.shown) { sent.current.shown = true; events.current.onShown?.(); }
  }, [onScreen]);
  useEffect(() => {
    if (panelsOnRoof > 0 && panelsOnRoof !== sent.current.panels) { sent.current.panels = panelsOnRoof; events.current.onPanelsPlaced?.(panelsOnRoof); }
  }, [panelsOnRoof]);
  useEffect(() => {
    if (equipmentKey && equipmentKey !== sent.current.equipment) { sent.current.equipment = equipmentKey; events.current.onEquipmentPlaced?.(); }
  }, [equipmentKey]);
  const canEdit = editable && mode === "planner" && !reveal && show3d && spec.components.pv.visible;
  const commit = (slots: PanelSlot[]) => {
    setEdited({ for: layoutKey, slots });
    onPanelsChange?.(slots.map((s) => ({ id: s.id, segment: s.plane === "main" ? 0 : 1, u: s.u, v: s.v, portrait: true })));
  };
  const pickedSlot = picked ? spec.layout.slots.find((s) => s.id === picked) ?? null : null;
  const locked = useMemo(() => new Set(baseSpec.layout.slots.slice(0, baseSpec.existingPanels).map((s) => s.id)), [baseSpec]);
  const panelEdit: PanelEditing | null = canEdit
    ? {
        selected: pickedSlot?.id ?? null, grid, locked,
        onPick: (id) => setPicked(id && locked.has(id) ? null : id),
        onMove: (id, to) => { if (locked.has(id)) return; commit(movePanel(spec.layout.slots, id, to)); setPicked(id); },
      }
    : null;
  // Delete / Backspace removes the picked panel, Escape lets go (not while typing elsewhere)
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  useEffect(() => {
    keys.current = (e) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (e.key === "Escape") setPicked(null);
      if ((e.key === "Delete" || e.key === "Backspace") && pickedSlot) {
        e.preventDefault();
        commit(removePanel(spec.layout.slots, pickedSlot.id, locked));
        setPicked(null);
      }
    };
  });
  useEffect(() => {
    if (!canEdit) return;
    const on = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [canEdit]);
  const enginePanels = baseSpec.layout.requested - baseSpec.existingPanels;
  const placedPanels = spec.layout.slots.length - baseSpec.existingPanels;
  const c = spec.components;
  const activeSpec = active ? c[active] : null;
  const homeowner = mode === "homeowner";

  const rows: { key: string; comp?: CompKey; label: string; size?: string | null; value: ReactNode }[] = [];
  if (c.pv.visible) rows.push({ key: "pv", comp: "pv", label: "Solar", size: c.pv.size?.split(" (")[0], value: kw(moment.pv) });
  if (c.battery.visible) {
    const dir = moment.batteryIn > 0.05 ? "in" : moment.batteryOut > 0.05 ? "out" : null;
    rows.push({
      key: "battery", comp: "battery", label: "Battery", size: c.battery.size,
      value: (
        <span className="inline-flex items-center gap-1">
          {dir === "in" && <ArrowUp aria-label="charging" className="size-3 text-comp-battery" strokeWidth={2} />}
          {dir === "out" && <ArrowDown aria-label="discharging" className="size-3 text-comp-battery" strokeWidth={2} />}
          {Math.round(moment.soc * 100)} %
        </span>
      ),
    });
  }
  if (c.wallbox.visible) rows.push({ key: "car", comp: "wallbox", label: "Car", size: c.wallbox.size, value: kw(moment.car) });
  if (c.heatpump.visible) rows.push({ key: "hp", comp: "heatpump", label: "Heat pump", size: c.heatpump.size, value: kw(moment.heatpump) });
  rows.push({ key: "home", label: homeowner ? "Your home" : "Home", value: kw(moment.home - moment.heatpump) });
  const exporting = moment.gridExport > moment.gridImport;
  rows.push({ key: "grid", label: exporting ? "To grid" : "From grid", value: kw(exporting ? moment.gridExport : moment.gridImport) });

  const valueText = `${clock(hour)}. Solar ${kw(moment.pv)}${c.battery.visible ? `, battery ${Math.round(moment.soc * 100)} %` : ""}.`;

  return (
    <figure
      ref={figure}
      className={cn("relative isolate w-full overflow-hidden rounded-lg border border-border bg-surface-0", className)}
    >
      <div data-h3d-stage className="@container relative aspect-[4/3] w-full md:aspect-[16/10]">
        {/* eslint-disable-next-line @next/next/no-img-element -- static fallback must work without the image optimiser */}
        <img
          src={FALLBACK_IMAGE[theme]}
          alt={show3d ? "" : spec.summary}
          aria-hidden={show3d}
          className={cn("absolute inset-0 size-full object-cover transition-opacity duration-300", show3d && ready ? "opacity-0" : "opacity-100")}
        />
        {show3d && (
          <div
            role="img"
            aria-label={spec.summary}
            className={cn("absolute inset-0 transition-opacity duration-300", ready ? "opacity-100" : "opacity-0")}
          >
            <SceneBoundary onError={() => setFailed(true)}>
              <Scene
                spec={spec}
                palette={palette}
                dark={theme === "dark"}
                reduced={reduced}
                preset={preset}
                active={active}
                pointer={pointer}
                moment={moment}
                flows={flows}
                batteryKwh={design.design.battery.kwh}
                flyIn={flyIn && !reveal}
                shown={shownParts}
                building={!!reveal}
                hpOption={!!design.options?.heatpump?.available && !!reveal}
                hpOptionKw={design.options?.heatpump?.available ? design.options.heatpump.kw : null}
                labels={labels}
                cameraKey={cameraKey}
                panelEdit={panelEdit}
                focus={focused}
                flowsOn={flowsOn}
                inView={inView}
                onMiss={() => { if (selectedRef.current) select(null); }}
                onReady={onReady}
              />
            </SceneBoundary>
          </div>
        )}

        {/* planner panel editing: placement only, the engine's size stays */}
        {panelEdit && controls !== "none" && controls !== "time" && (
          <div
            data-h3d-ui
            role="toolbar"
            aria-label="Edit panels"
            className={cn("absolute bottom-3 left-3 hidden items-center gap-1 p-1 @[520px]:flex", glassPanel, "rounded-full")}
          >
            <span className={cn("px-2.5 font-mono text-[12px] tabular-nums", placedPanels === enginePanels ? "text-ink-body" : "text-warning-text")}>
              Placed {placedPanels} of {enginePanels}
            </span>
            <button type="button" onClick={() => commit(addPanel(spec.layout.slots, grid, pickedSlot))} className={cn(pill, "h-7 text-ink-body [@media(hover:hover)]:hover:bg-surface-2")}>Add</button>
            <button type="button" disabled={!pickedSlot} onClick={() => { if (pickedSlot) { commit(removePanel(spec.layout.slots, pickedSlot.id, locked)); setPicked(null); } }} className={cn(pill, "h-7 text-ink-body disabled:opacity-40 [@media(hover:hover)]:hover:bg-surface-2")}>Remove</button>
            {editedSlots && (
              <button type="button" onClick={() => { setEdited(null); setPicked(null); onPanelsChange?.(null); }} className={cn(pill, "h-7 text-ink-body [@media(hover:hover)]:hover:bg-surface-2")}>Reset</button>
            )}
          </div>
        )}

        {/* camera presets: the only control over the model; only on stages wide enough to keep them off the roof
            (two houses side by side on /reality: none) */}
        {show3d && controls !== "none" && controls !== "time" && (
          <div data-h3d-ui className="absolute right-3 top-3 hidden items-center gap-1.5 @[640px]:flex">
            <div role="group" aria-label="Camera view" className={cn("flex gap-1 p-1", glassPanel, "rounded-full")}>
              {PRESETS.map((p) => (
                <button
                  key={p}
                  type="button"
                  aria-pressed={preset.preset === p}
                  onClick={() => { if (selectedRef.current) select(null); setPreset((r) => ({ preset: p, n: r.n + 1 })); }}
                  className={cn(pill, "h-7", preset.preset === p ? "bg-primary text-primary-ink" : "text-ink-body [@media(hover:hover)]:hover:bg-surface-2")}
                >
                  {PRESET_LABEL[p]}
                </button>
              ))}
            </div>
            {flowsProp === undefined && (
              <button
                type="button"
                aria-pressed={flowsOn}
                onClick={() => setOwnFlows(!flowsOn)}
                className={cn(pill, glassPanel, "rounded-full", flowsOn ? "text-ink" : "text-ink-muted", "[@media(hover:hover)]:hover:bg-surface-2")}
              >
                <span aria-hidden className={cn("mr-1.5 inline-block size-2 rounded-full transition-colors", flowsOn ? "bg-ai-amber" : "bg-border")} />
                Energy flow
              </button>
            )}
            {mode === "planner" && (
              <button type="button" onClick={saveImage} className={cn(pill, glassPanel, "hidden rounded-full text-ink @[700px]:inline-flex [@media(hover:hover)]:hover:bg-surface-2")}>
                Save image
              </button>
            )}
          </div>
        )}
      </div>

      {/* time and live numbers sit under the model, never over it */}
      {(controls === "full" || controls === "time") && (
        <div data-h3d-ui className="flex flex-col gap-2 border-t border-border px-3 pb-2.5 pt-3 sm:px-4">
          {show3d && (
            <TimeBar
              day={day}
              hour={hour}
              playing={playing}
              canPlay={canPlay}
              valueText={valueText}
              onHour={(h) => { setPlaying(false); setHour(h); }}
              onTogglePlay={() => setPlaying((p) => !p)}
            />
          )}
          <ul aria-label={show3d ? "The system right now" : "The system"} className="grid grid-cols-2 gap-x-2 sm:flex sm:flex-wrap sm:gap-x-1">
            {rows.map((r) => {
              const body = (
                <>
                  <span className="flex min-w-0 items-center gap-2">
                    {r.comp ? <span aria-hidden className={cn("size-2 shrink-0 rounded-full", DOT[r.comp])} /> : <span aria-hidden className="size-2 shrink-0 rounded-full border border-border-strong" />}
                    <span className="truncate text-ink">{r.label}</span>
                    {r.size && <span className="hidden truncate font-mono text-[12px] text-ink-muted tabular-nums md:inline">{r.size}</span>}
                  </span>
                  {show3d && <span className="shrink-0 font-mono text-[13px] font-medium tabular-nums text-ink">{r.value}</span>}
                </>
              );
              const rowCls = "flex h-8 w-full items-center justify-between gap-3 rounded-md px-2 text-left text-[13px] sm:w-auto";
              return (
                <li key={r.key}>
                  {r.comp ? (
                    <button
                      type="button"
                      aria-pressed={selected === r.comp}
                      onClick={() => select(selected === r.comp ? null : r.comp!)}
                      onPointerEnter={(e) => { if (e.pointerType === "mouse") setHovered(r.comp!); }}
                      onPointerLeave={(e) => { if (e.pointerType === "mouse") setHovered(null); }}
                      className={cn(
                        rowCls,
                        "outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-focus",
                        "[@media(hover:hover)]:hover:bg-surface-2",
                        active === r.comp && "bg-surface-2",
                      )}
                    >
                      {body}
                    </button>
                  ) : (
                    <div className={cn(rowCls, "text-ink-body")}>{body}</div>
                  )}
                </li>
              );
            })}
          </ul>
          {/* Details of the selected part. Always mounted (live region); in 3D on larger screens the floating
              tooltip shows it and this stays for screen readers. */}
          <p
            role="status"
            className={cn("px-2 text-[13px] leading-[18px] text-ink-body empty:hidden", show3d && "sm:sr-only")}
          >
            {activeSpec && (
              <>
                <span className="font-semibold text-ink">{activeSpec.title}</span>
                {activeSpec.size && <span className="font-mono tabular-nums"> · {activeSpec.size}</span>}
                {activeSpec.reason && <> · {activeSpec.reason}</>}
                {activeSpec.note && <span className="text-warning-text"> · {activeSpec.note}</span>}
              </>
            )}
          </p>
        </div>
      )}
    </figure>
  );
}

/** Time-of-day slider drawn over the day's solar curve (the only colour in the chrome is the energy itself). */
function TimeBar({ day, hour, playing, canPlay, valueText, onHour, onTogglePlay, className }: {
  day: Day; hour: number; playing: boolean; canPlay: boolean; valueText: string;
  onHour: (h: number) => void; onTogglePlay: () => void; className?: string;
}) {
  const curve = useMemo(() => {
    const steps = day.steps.filter((s) => s.t >= DAY_START && s.t <= DAY_END);
    const peak = Math.max(0.5, ...steps.map((s) => s.pv));
    const x = (t: number) => ((t - DAY_START) / (DAY_END - DAY_START)) * 100;
    const y = (p: number) => 20 - (p / peak) * 17;
    const line = steps.map((s, i) => `${i ? "L" : "M"}${x(s.t).toFixed(2)},${y(s.pv).toFixed(2)}`).join(" ");
    return { line, area: `${line} L100,20 L0,20 Z` };
  }, [day]);
  const pct = ((hour - DAY_START) / (DAY_END - DAY_START)) * 100;

  return (
    <div className={cn("flex items-center gap-3", className)}>
      {canPlay && <button
        type="button"
        onClick={onTogglePlay}
        aria-label={playing ? "Pause the day" : "Play the day"}
        className={cn(pill, "size-8 shrink-0 justify-center bg-surface-2 px-0 text-ink [@media(hover:hover)]:hover:bg-border")}
      >
        {playing ? <Pause className="size-3.5" strokeWidth={2} /> : <Play className="size-3.5 translate-x-px" strokeWidth={2} />}
      </button>}
      <div className="w-[4.5rem] shrink-0 sm:w-36">
        <div className="font-mono text-lg font-medium leading-6 tabular-nums tracking-tight text-ink">{clock(hour)}</div>
        <div className="hidden text-[11px] leading-4 text-ink-muted sm:block">Sunny day in May, modelled</div>
      </div>
      <div className="relative min-w-0 flex-1">
        <svg aria-hidden viewBox="0 0 100 20" preserveAspectRatio="none" className="pointer-events-none absolute inset-x-0 -top-1 h-6 w-full">
          <defs>
            <linearGradient id="house3d-sun" x1="0" x2="1" y1="0" y2="0">
              <stop offset="0%" stopColor="var(--color-ai-amber)" />
              <stop offset="55%" stopColor="var(--color-ai-orange)" />
              <stop offset="100%" stopColor="var(--color-ai-salmon)" />
            </linearGradient>
          </defs>
          <path d={curve.area} fill="url(#house3d-sun)" opacity={0.22} />
          <path d={curve.line} fill="none" stroke="url(#house3d-sun)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
          <line x1={pct} x2={pct} y1={0} y2={20} stroke="var(--color-ink)" strokeOpacity={0.35} strokeWidth={1} vectorEffect="non-scaling-stroke" />
        </svg>
        <input
          type="range"
          min={DAY_START}
          max={DAY_END}
          step={playing ? "any" : 0.25}
          value={hour}
          onChange={(e) => onHour(Number(e.target.value))}
          aria-label="Time of day"
          aria-valuetext={valueText}
          className={cn(
            "relative mt-3 block h-6 w-full cursor-pointer appearance-none bg-transparent outline-none",
            "[&::-webkit-slider-runnable-track]:h-[3px] [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-border-strong/40",
            "[&::-webkit-slider-thumb]:-mt-[8.5px] [&::-webkit-slider-thumb]:size-5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full",
            "[&::-webkit-slider-thumb]:border [&::-webkit-slider-thumb]:border-border-strong [&::-webkit-slider-thumb]:bg-surface-1",
            "[&::-webkit-slider-thumb]:shadow-[0_1px_3px_rgba(16,17,20,0.18)] [&::-webkit-slider-thumb]:transition-transform [&::-webkit-slider-thumb]:duration-150",
            "active:[&::-webkit-slider-thumb]:scale-110",
            "[&::-moz-range-track]:h-[3px] [&::-moz-range-track]:rounded-full [&::-moz-range-track]:bg-border-strong/40",
            "[&::-moz-range-thumb]:size-5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border [&::-moz-range-thumb]:border-border-strong [&::-moz-range-thumb]:bg-surface-1",
            "focus-visible:[&::-webkit-slider-thumb]:ring-2 focus-visible:[&::-webkit-slider-thumb]:ring-focus",
            "focus-visible:[&::-moz-range-thumb]:ring-2 focus-visible:[&::-moz-range-thumb]:ring-focus",
          )}
        />
        <div aria-hidden className="mt-0.5 flex justify-between font-mono text-[11px] tabular-nums text-ink-muted">
          <span>06:00</span>
          <span>12:00</span>
          <span>18:00</span>
          <span>22:00</span>
        </div>
      </div>
    </div>
  );
}
