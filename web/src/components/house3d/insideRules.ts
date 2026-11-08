/**
 * The inside diorama's rules, pure: three zones side by side, a few slots along each zone's back wall, and where
 * each part may go. World: +x right, +z towards the viewer, y up; the board's top is y = 0.
 */
export type Zone = "basement" | "garage" | "outside";
export type InsideKey = "battery" | "inverter" | "heatpump" | "wallbox";
export const INSIDE_KEYS: readonly InsideKey[] = ["battery", "inverter", "heatpump", "wallbox"];
export type Placement = Partial<Record<InsideKey, { zone: Zone; slot: number }>>;

export interface ZoneSpec {
  zone: Zone;
  label: string;
  /** x range of the zone's floor */
  x0: number;
  x1: number;
  /** floor height (the basement is sunk) */
  floorY: number;
  /** slot x positions along the back wall */
  slots: number[];
}

export const ZONES: Record<Zone, ZoneSpec> = {
  basement: { zone: "basement", label: "Basement", x0: -5.2, x1: -1.9, floorY: -1.4, slots: [-4.4, -3.5, -2.6] },
  garage: { zone: "garage", label: "Garage", x0: -1.6, x1: 1.9, floorY: 0, slots: [-1.0, 0.15, 1.3] },
  outside: { zone: "outside", label: "Outside wall", x0: 2.2, x1: 5.6, floorY: 0, slots: [3.0, 4.1, 5.0] },
};
export const ZONE_ORDER: readonly Zone[] = ["basement", "garage", "outside"];
/** Back wall plane (items stand against it or hang on it). */
export const WALL_Z = -1.6;

export const ALLOWED: Record<InsideKey, readonly Zone[]> = {
  battery: ["basement", "garage"],
  inverter: ["basement", "garage", "outside"],
  heatpump: ["outside"],
  wallbox: ["garage", "outside"],
};

/** Why a part cannot go into a zone (plain words for the planner and the homeowner). */
export const WHY_NOT: Record<InsideKey, string> = {
  battery: "The battery stays indoors and frost-free.",
  inverter: "",
  heatpump: "The heat pump needs outside air.",
  wallbox: "The wallbox goes where the car parks.",
};

export const DEFAULTS: Record<InsideKey, Zone> = { battery: "garage", inverter: "garage", heatpump: "outside", wallbox: "garage" };

/** An area on the board (x right, z towards the viewer). */
export interface Rect { x0: number; z0: number; x1: number; z1: number }

/**
 * Where the zones are drawn: the generic section below, or the rooms of an uploaded floor plan (floorPlanLayout.ts).
 * Slots are scene points [x, y, z] with a part's back against the wall there.
 */
export interface InsideGeo {
  zones: Record<Zone, {
    label: string; rect: Rect; slots: readonly (readonly [number, number, number])[];
    /** Which way the parts face (radians about y; 0 = towards the viewer, +π/2 = towards +x). */
    yaw?: number;
  }>;
}

/** The board's depth (z) in the generic section. */
export const DEPTH = [-2.4, 2.2] as const;

export const GENERIC: InsideGeo = {
  zones: Object.fromEntries(ZONE_ORDER.map((z) => {
    const s = ZONES[z];
    return [z, { label: s.label, rect: { x0: s.x0, z0: WALL_Z, x1: s.x1, z1: DEPTH[1] }, slots: s.slots.map((x) => [x, s.floorY, WALL_Z] as const) }];
  })) as unknown as InsideGeo["zones"],
};

/** Zone under a point, or null between zones / off the board. The generic section only looks at x. */
export function zoneAt(x: number, z?: number, geo: InsideGeo = GENERIC): Zone | null {
  const pad = 0.3;
  return ZONE_ORDER.find((k) => {
    const r = geo.zones[k].rect;
    if (x < r.x0 - (geo === GENERIC ? 0 : pad) || x > r.x1 + (geo === GENERIC ? 0 : pad)) return false;
    return geo === GENERIC || z === undefined || (z >= r.z0 - pad && z <= r.z1 + pad);
  }) ?? null;
}

/** First free slot in a zone, preferring the one nearest (x, z). null when the zone is full. */
export function freeSlot(p: Placement, zone: Zone, x: number, except?: InsideKey, geo: InsideGeo = GENERIC, z?: number): number | null {
  const taken = new Set(INSIDE_KEYS.filter((k) => k !== except && p[k]?.zone === zone).map((k) => p[k]!.slot));
  const order = geo.zones[zone].slots
    .map((s, i) => ({ i, d: Math.hypot(s[0] - x, z === undefined ? 0 : s[2] - z) }))
    .sort((a, b) => a.d - b.d);
  return order.find((o) => !taken.has(o.i))?.i ?? null;
}

/** Default placement for the parts the design has. */
export function defaultPlacement(keys: readonly InsideKey[], geo: InsideGeo = GENERIC): Placement {
  const p: Placement = {};
  for (const k of keys) {
    const zone = DEFAULTS[k];
    const slot = freeSlot(p, zone, geo.zones[zone].slots[0][0], undefined, geo);
    if (slot !== null) p[k] = { zone, slot };
  }
  return p;
}

export type DropResult = { ok: true; placement: Placement } | { ok: false; reason: string };

/** Drop a part at (x, z): snaps into the nearest free slot of the zone under it, or says why it goes back. */
export function drop(p: Placement, key: InsideKey, x: number, z?: number, geo: InsideGeo = GENERIC): DropResult {
  const zone = zoneAt(x, z, geo);
  if (!zone) return { ok: false, reason: geo === GENERIC ? "Drop it into one of the three areas." : "Drop it into one of the highlighted rooms." };
  return moveTo(p, key, zone, x, geo, z);
}

export function moveTo(p: Placement, key: InsideKey, zone: Zone, x?: number, geo: InsideGeo = GENERIC, z?: number): DropResult {
  const label = geo.zones[zone].label;
  if (!ALLOWED[key].includes(zone)) return { ok: false, reason: WHY_NOT[key] || "Not here." };
  const slot = freeSlot(p, zone, x ?? geo.zones[zone].slots[0][0], key, geo, z);
  if (slot === null) return { ok: false, reason: `The ${label.toLowerCase()} is full.` };
  return { ok: true, placement: { ...p, [key]: { zone, slot } } };
}

/** Where a placed part stands in the scene. */
export function slotPosition(zone: Zone, slot: number, geo: InsideGeo = GENERIC): [number, number, number] {
  const s = geo.zones[zone].slots[slot];
  return [s[0], s[1], s[2]];
}
