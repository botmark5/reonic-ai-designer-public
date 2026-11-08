/**
 * Floor plan of a home, read from an uploaded drawing (POST /api/floorplan, Claude vision). LAYOUT ONLY: the 3D Inside
 * view draws these rooms; no size of the energy system ever comes from here.
 *
 * Coordinates are metres. The origin is the top-left corner of the outer footprint as drawn. x runs right (0..widthM),
 * y runs down the drawing (0..depthM), so the bottom edge is the front of the house. Rooms are axis-aligned rectangles.
 */
export const ROOM_KINDS = ["garage", "utility", "basement", "living", "kitchen", "bedroom", "bath", "hall", "other"] as const;
export type RoomKind = (typeof ROOM_KINDS)[number];

export interface FloorPlanRoom {
  name: string;
  kind: RoomKind;
  x: number;
  y: number;
  w: number;
  h: number;
  /** -1 basement, 0 ground floor, 1 upper floor */
  floor: -1 | 0 | 1;
}

export interface FloorPlan {
  widthM: number;
  depthM: number;
  rooms: FloorPlanRoom[];
}

export const MAX_ROOMS = 40;
const MIN_SIDE_M = 0.3;
const FOOTPRINT_M = [3, 60] as const;
const NAME_MAX = 40;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const cm = (v: number) => Math.round(v * 100) / 100;

/** Validates and clamps a model's answer: rooms inside the footprint, known kinds and floors, at most 40 rooms.
 *  Returns null when nothing usable is left (no footprint, implausible size, no rooms). */
export function sanitizeFloorPlan(raw: unknown): FloorPlan | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const widthM = num(r.widthM);
  const depthM = num(r.depthM);
  if (widthM == null || depthM == null) return null;
  if ([widthM, depthM].some((d) => d < FOOTPRINT_M[0] || d > FOOTPRINT_M[1])) return null;
  if (!Array.isArray(r.rooms)) return null;

  const rooms: FloorPlanRoom[] = [];
  for (const item of r.rooms) {
    if (rooms.length >= MAX_ROOMS) break;
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const name = typeof o.name === "string" ? o.name.trim().slice(0, NAME_MAX) : "";
    const [x0, y0, w0, h0] = [num(o.x), num(o.y), num(o.w), num(o.h)];
    if (!name || x0 == null || y0 == null || w0 == null || h0 == null) continue;
    const x = Math.min(Math.max(x0, 0), widthM);
    const y = Math.min(Math.max(y0, 0), depthM);
    const w = Math.min(x0 + w0, widthM) - x;
    const h = Math.min(y0 + h0, depthM) - y;
    if (w < MIN_SIDE_M || h < MIN_SIDE_M) continue;
    const kind = (ROOM_KINDS as readonly string[]).includes(o.kind as string) ? (o.kind as RoomKind) : "other";
    const floor = o.floor === -1 || o.floor === 1 ? o.floor : 0;
    rooms.push({ name, kind, x: cm(x), y: cm(y), w: cm(w), h: cm(h), floor });
  }
  return rooms.length ? { widthM: cm(widthM), depthM: cm(depthM), rooms } : null;
}
