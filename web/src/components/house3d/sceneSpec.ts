/**
 * Everything the 3D scene shows, decided from the engine's design. Pure: no three.js, no React.
 */
import type { DesignResponse, Home } from "../../lib/types";
import { EXISTING_ID, layoutPanels, panelCount, PANEL, type Layout, type RoofPlane } from "./layout";
import type { ComponentKey, House3DMode, RoofInput } from "./types";

export type CompKey = ComponentKey;
export const COMP_KEYS: readonly CompKey[] = ["pv", "battery", "inverter", "wallbox", "heatpump"];

export interface CompSpec {
  key: CompKey;
  visible: boolean;
  title: string;
  /** Size with unit, e.g. "7.2 kWp (16 × 450 W)". null when not shown. */
  size: string | null;
  /** The engine's first reason, if any. */
  reason: string | null;
  /** Extra fact shown in the tooltip, e.g. panels that don't fit. */
  note: string | null;
}

export type FlowNode = "sun" | "panels" | "inverter" | "battery" | "house" | "wallbox" | "car" | "heatpump";
export interface Flow {
  id: string;
  from: FlowNode;
  to: FlowNode;
  color: Exclude<CompKey, "inverter">;
}

export interface ResolvedRoof {
  pitchDeg: number;
  azimuthDeg: number;
}

export interface SceneSpec {
  layout: Layout;
  components: Record<CompKey, CompSpec>;
  flows: Flow[];
  roof: ResolvedRoof;
  /** The first `existingPanels` slots of the layout are panels already on the roof (battery retrofit, add-ons). */
  existingPanels: number;
  /** One sentence for screen readers and the static image's alt text. */
  summary: string;
}

const DEFAULT_PITCH = 35;
/** engine/model.py TYPICAL_EXISTING_PV_KWP */
const TYPICAL_EXISTING_PV_KWP = 8;
const DEFAULT_AZIMUTH = 180;
/** Pitches outside this range would not read as a gable house; the drawing clamps them. */
const PITCH_RANGE: [number, number] = [15, 50];

const finite = (x: number | null | undefined): x is number => x != null && Number.isFinite(x);
const positive = (x: number | null | undefined): x is number => finite(x) && x > 0;
/** Up to two decimals, no trailing zeros: catalogue PV sizes are multiples of 0.45 kWp (9.45, 10.8, 11.25). */
const num = (x: number) => String(Number(x.toFixed(2)));

/**
 * Roof direction and pitch: the planner's roof fields (home.roof_*, filled from Google Solar and editable) first, then
 * the `roof` prop, then the older orientation/tilt fields, then 35° south.
 */
export function resolveRoof(home: Home, roof?: RoofInput): ResolvedRoof {
  const pitch = [home.roof_pitch, roof?.pitchDeg, home.tilt_deg].find(finite) ?? DEFAULT_PITCH;
  const azimuth = [home.roof_azimuth, roof?.azimuthDeg, home.orientation_deg].find(finite) ?? DEFAULT_AZIMUTH;
  return {
    pitchDeg: Math.min(PITCH_RANGE[1], Math.max(PITCH_RANGE[0], pitch)),
    azimuthDeg: ((azimuth % 360) + 360) % 360,
  };
}

export function buildSceneSpec(
  response: DesignResponse,
  home: Home,
  mode: House3DMode,
  planesFor: (pitchDeg: number) => RoofPlane[],
  roofInput?: RoofInput,
): SceneSpec {
  const { pv, battery, wallbox, heatpump } = response.design;
  const roof = resolveRoof(home, roofInput);
  const homeowner = mode === "homeowner";

  const designPanels = pv.include ? panelCount(pv.kwp) : 0;
  const pvOn = designPanels > 0; // < 0.225 kWp rounds to no panel at all
  // panels already on the roof; "yes, there is PV" without a size assumes 8 kWp, like the engine (TYPICAL_EXISTING_PV_KWP)
  const sizeGiven = positive(home.existing_pv_kwp);
  const existingKwp = home.has_existing_pv === false ? 0 : sizeGiven ? home.existing_pv_kwp! : home.has_existing_pv ? TYPICAL_EXISTING_PV_KWP : 0;
  const existingWanted = panelCount(existingKwp);
  // the roof cap limits the new panels only (as in the engine). The planner's field wins; an explicit null means
  // "no cap" (removed by the planner), undefined falls back to the Google Solar prop.
  const cap = home.roof_max_kwp;
  const maxNew = cap === null ? undefined : finite(cap) && cap >= 0 ? Math.floor(cap / PANEL.kwp + 1e-6) : roofInput?.maxPanels;
  const packed = layoutPanels(existingWanted + panelCount(pv.include ? pv.kwp : 0, maxNew), planesFor(roof.pitchDeg));
  const existingPanels = Math.min(existingWanted, packed.placed);
  // the first slots are the panels already there; their own ids keep them apart from a proposal in the same spot
  const layout: Layout = { ...packed, slots: packed.slots.map((s, i) => (i < existingPanels ? { ...s, id: EXISTING_ID + s.id } : s)) };
  const missing = designPanels - (layout.placed - existingPanels);
  const solarOn = pvOn || existingWanted > 0;
  const panelsOn = layout.placed > 0;
  const pvSize = (): string | null => {
    if (homeowner) return `${designPanels + existingWanted} panels`;
    const old = sizeGiven ? `${num(existingKwp)} kWp existing` : `≈ ${num(existingKwp)} kWp existing (size not given)`;
    if (!pvOn) return old; // the engine sends kwp: null when it adds no PV
    const fresh = `${num(pv.kwp!)} kWp${existingWanted ? " new" : ""} (${designPanels} × ${PANEL.kwp * 1000} W)`;
    return existingWanted ? `${fresh} + ${old}` : fresh;
  };

  const batOn = battery.include && positive(battery.kwh);
  const wbOn = wallbox.include;
  const hpOn = heatpump.include;

  const first = (r: string[]) => r[0] ?? null;
  const comp = (key: CompKey, visible: boolean, title: string, size: string | null, reason: string | null, note: string | null = null): CompSpec =>
    ({ key, visible, title, size: visible ? size : null, reason: visible ? reason : null, note: visible ? note : null });

  const components: Record<CompKey, CompSpec> = {
    pv: comp(
      "pv", solarOn,
      pvOn ? (homeowner ? "Solar panels" : "PV") : homeowner ? "Your solar panels" : "Existing PV",
      solarOn ? pvSize() : null,
      pvOn ? first(pv.reasons) : null,
      pvOn && missing > 0 ? `${missing} of ${designPanels} panels don't fit on this roof` : null,
    ),
    battery: comp("battery", batOn, "Battery", batOn ? `${num(battery.kwh!)} kWh` : null, first(battery.reasons)),
    inverter: comp(
      "inverter", pvOn || (existingWanted > 0 && panelsOn), "Inverter", null,
      homeowner ? "Turns the panels' power into power for your home." : "Converts PV DC to AC for the house and battery.",
    ),
    wallbox: comp(
      "wallbox", wbOn,
      homeowner ? "Car charger" : "Wallbox",
      !homeowner && positive(wallbox.kw) ? `${num(wallbox.kw)} kW` : null,
      first(wallbox.reasons),
    ),
    heatpump: comp(
      "heatpump", hpOn, "Heat pump",
      !homeowner && positive(heatpump.kw) ? `${num(heatpump.kw)} kW` : null,
      first(heatpump.reasons),
    ),
  };

  const all: Array<Flow & { on: boolean }> = [
    { id: "sun-panels", from: "sun", to: "panels", color: "pv", on: panelsOn },
    { id: "panels-inverter", from: "panels", to: "inverter", color: "pv", on: panelsOn },
    { id: "inverter-battery", from: "inverter", to: "battery", color: "battery", on: (pvOn || panelsOn) && batOn },
    { id: "inverter-house", from: "inverter", to: "house", color: "pv", on: pvOn || panelsOn },
    { id: "house-wallbox", from: "house", to: "wallbox", color: "wallbox", on: wbOn },
    { id: "wallbox-car", from: "wallbox", to: "car", color: "wallbox", on: wbOn },
    { id: "house-heatpump", from: "house", to: "heatpump", color: "heatpump", on: hpOn },
  ];
  const flows: Flow[] = all.filter((f) => f.on).map(({ id, from, to, color }) => ({ id, from, to, color }));

  return { layout, components, flows, roof, existingPanels, summary: summarize(pvOn ? layout.placed : existingPanels, components) };
}

function summarize(panels: number, c: Record<CompKey, CompSpec>): string {
  const extras: string[] = [];
  if (c.battery.visible) extras.push(`a ${c.battery.size} battery`);
  if (c.wallbox.visible) extras.push("a car charger");
  if (c.heatpump.visible) extras.push("a heat pump");
  const list = extras.length > 1 ? `${extras.slice(0, -1).join(", ")} and ${extras.at(-1)}` : extras[0];
  if (!c.pv.visible) return list ? `House without solar panels, with ${list}.` : "House without solar panels.";
  return `House with ${panels} solar panels${list ? `, ${list}` : ""}.`;
}
