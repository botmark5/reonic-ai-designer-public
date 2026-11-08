/**
 * Planner panel editing on the procedural roof, pure. Editing only PLACES panels; the engine's size never changes.
 * Candidates are every full-grid position on each plane; a spot is free when no placed panel overlaps it (the
 * design's centred last row sits half a panel off the grid, so overlap, not grid identity, decides).
 */
import { PANEL, capacity, type PanelSlot, type PlaneId, type RoofPlane } from "./layout";

const EPS = 1e-3;

export function fullGrid(planes: RoofPlane[]): PanelSlot[] {
  const out: PanelSlot[] = [];
  for (const plane of planes) {
    const { cols, rows } = capacity(plane);
    for (let row = 0; row < rows; row++) {
      const v = plane.margin.eave + PANEL.h / 2 + row * (PANEL.h + PANEL.gap);
      for (let col = 0; col < cols; col++) {
        const u = (col - (cols - 1) / 2) * (PANEL.w + PANEL.gap);
        out.push({ id: `${plane.id}-r${row}u${Math.round(u * 1000)}`, plane: plane.id, u, v });
      }
    }
  }
  return out;
}

export function overlaps(a: Pick<PanelSlot, "plane" | "u" | "v">, b: Pick<PanelSlot, "plane" | "u" | "v">): boolean {
  return a.plane === b.plane && Math.abs(a.u - b.u) < PANEL.w + PANEL.gap - EPS && Math.abs(a.v - b.v) < PANEL.h + PANEL.gap - EPS;
}

/** Shares an edge with `b` (same row side by side, or the row above/below overlapping in u). */
export function touches(a: Pick<PanelSlot, "plane" | "u" | "v">, b: Pick<PanelSlot, "plane" | "u" | "v">): boolean {
  if (a.plane !== b.plane) return false;
  const du = Math.abs(a.u - b.u);
  const dv = Math.abs(a.v - b.v);
  const W = PANEL.w + PANEL.gap;
  const H = PANEL.h + PANEL.gap;
  return (dv < EPS && du < W + EPS) || (Math.abs(dv - H) < EPS && du < W - EPS);
}

/**
 * The free grid spot nearest (u, v) on `plane`, ignoring the panel `except` (the one being moved). With `attached`,
 * only spots touching another panel on that plane count (no islands), unless that plane has none yet.
 */
export function nearestFree(placed: PanelSlot[], grid: PanelSlot[], plane: PlaneId, u: number, v: number, except?: string, attached = false): PanelSlot | null {
  const others = placed.filter((p) => p.id !== except);
  const onPlane = others.filter((p) => p.plane === plane);
  const needTouch = attached && onPlane.length > 0;
  let best: PanelSlot | null = null;
  let bestD = Infinity;
  for (const c of grid) {
    if (c.plane !== plane || others.some((p) => overlaps(p, c))) continue;
    if (needTouch && !onPlane.some((p) => touches(p, c))) continue;
    const d = (c.u - u) ** 2 + (c.v - v) ** 2;
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}

/**
 * Move ONE panel to a free spot; nothing else moves (the spot it left stays free: the planner chose it).
 * Ids are stable through moves (the renderer glides a panel to its new spot instead of swapping it).
 */
export function movePanel(placed: PanelSlot[], id: string, to: PanelSlot): PanelSlot[] {
  const from = placed.find((p) => p.id === id);
  if (!from || placed.some((p) => p.id !== id && overlaps(p, to))) return placed;
  return placed.map((p) => (p.id === id ? { ...to, id } : p));
}

/** `id`, or `id` with a suffix when a moved panel already carries it. */
function uniqueId(placed: PanelSlot[], id: string): string {
  const taken = new Set(placed.map((p) => p.id));
  let out = id;
  for (let k = 2; taken.has(out); k++) out = `${id}-${k}`;
  return out;
}

/** Add one panel next to `near` (or the first free spot of the main plane), if anything is free. */
export function addPanel(placed: PanelSlot[], grid: PanelSlot[], near?: PanelSlot | null): PanelSlot[] {
  const tries: [PlaneId, number, number][] = near
    ? [[near.plane, near.u, near.v], [near.plane === "main" ? "garage" : "main", 0, 0]]
    : [["main", 0, 0], ["garage", 0, 0]];
  for (const [plane, u, v] of tries) {
    const spot = nearestFree(placed, grid, plane, u, v, undefined, true);
    if (spot) return [...placed, { ...spot, id: uniqueId(placed, spot.id) }];
  }
  return placed;
}

/**
 * Remove a panel without leaving a hole: the outermost panel of the shorter side of its row takes the freed spot
 * (exactly one other panel moves, never one in `locked`). It keeps its id.
 */
export function removePanel(placed: PanelSlot[], id: string, locked?: ReadonlySet<string>): PanelSlot[] {
  const gone = placed.find((p) => p.id === id);
  const rest = placed.filter((p) => p.id !== id);
  return gone ? closeGap(rest, gone, locked) : rest;
}

/** `rest` has a hole where `gone` was: the outermost panel of the shorter unlocked side of that row fills it. */
function closeGap(rest: PanelSlot[], gone: PanelSlot, locked?: ReadonlySet<string>): PanelSlot[] {
  if (rest.some((p) => overlaps(p, gone))) return rest; // the spot is taken again
  const row = rest.filter((p) => p.plane === gone.plane && Math.abs(p.v - gone.v) < EPS);
  const left = row.filter((p) => p.u < gone.u);
  const right = row.filter((p) => p.u > gone.u);
  const free = (side: PanelSlot[]) => side.length > 0 && !side.some((p) => locked?.has(p.id));
  // only a real hole: panels on both sides
  if (!left.length || !right.length) return rest;
  const side = [left, right].filter(free).sort((a, b) => a.length - b.length)[0];
  if (!side) return rest;
  const outer = side.reduce((a, b) => (Math.abs(b.u - gone.u) > Math.abs(a.u - gone.u) ? b : a));
  return rest.map((p) => (p.id === outer.id ? { ...p, u: gone.u, v: gone.v } : p));
}
