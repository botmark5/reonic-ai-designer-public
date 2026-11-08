/**
 * An uploaded floor plan (b-web's FloorPlan, metres, origin top-left, y down the drawing, bottom edge = front) as the
 * Inside diorama's scene, pure. Layout only: no size of the energy system ever comes from a plan.
 *
 * Scene: +x right, +z towards the viewer (the front of the house), y up, the plate's top is y = 0. The ground floor is
 * one plate centred on the origin; basement rooms (floor -1) get their own plate to the left. The three equipment
 * zones snap into named rooms: basement → a basement room (else a utility room), garage → a garage room, outside →
 * a strip along the front facade. A zone the plan has no room for gets a small labelled tile next to the house, so
 * every part always has a home.
 */
import type { FloorPlan, RoomKind } from "../../lib/floorplan";
import type { InsideGeo, Rect, Zone } from "./insideRules";

export interface PlanRoom {
  name: string;
  kind: RoomKind;
  rect: Rect;
}

export interface PlanPlate {
  /** "Ground floor" / "Basement". */
  title: string;
  rect: Rect;
  rooms: PlanRoom[];
}

export interface PlanScene {
  plates: PlanPlate[];
  /** Tiles for zones the plan has no room for. */
  extras: { zone: Zone; rect: Rect; label: string }[];
  geo: InsideGeo;
  /** Centre and size of everything drawn, for the camera. */
  centre: [number, number];
  span: number;
}

const GAP = 1.4; // between the plates / tiles
const OUTSIDE_DEPTH = 2;
const TILE = 2.6;

const centreOf = (r: Rect): [number, number] => [(r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2];

/**
 * Three slots along a room's longest usable wall, the part's back against it: the back wall (far edge, min z),
 * or, in a deep narrow room like a garage, the left side wall with the parts turned to face into the room.
 */
function slotsIn(r: Rect, wallZ = r.z0, sideAllowed = true): { slots: [number, number, number][]; yaw: number } {
  const w = r.x1 - r.x0;
  const d = r.z1 - r.z0;
  const n = 3;
  if (sideAllowed && d > w * 1.3) {
    return { slots: Array.from({ length: n }, (_, i) => [r.x0, 0, r.z0 + (d * (i + 1)) / (n + 1)] as [number, number, number]), yaw: Math.PI / 2 };
  }
  return { slots: Array.from({ length: n }, (_, i) => [r.x0 + (w * (i + 1)) / (n + 1), 0, wallZ] as [number, number, number]), yaw: 0 };
}

export function planScene(plan: FloorPlan): PlanScene {
  const W = plan.widthM;
  const D = plan.depthM;
  const rect = (x: number, y: number, w: number, h: number, dx = 0): Rect => ({ x0: x - W / 2 + dx, z0: y - D / 2, x1: x + w - W / 2 + dx, z1: y + h - D / 2 });
  // rooms without a floor marking would never be lost: anything not -1 or 1 is the ground floor
  const ground = plan.rooms.filter((r) => r.floor !== -1 && r.floor !== 1);
  const below = plan.rooms.filter((r) => r.floor === -1);
  const groundPlate: PlanPlate = { title: "Ground floor", rect: rect(0, 0, W, D), rooms: ground.map((r) => ({ name: r.name, kind: r.kind, rect: rect(r.x, r.y, r.w, r.h) })) };
  const plates = [groundPlate];
  const basementShift = -(W + GAP);
  if (below.length) {
    plates.push({ title: "Basement", rect: rect(0, 0, W, D, basementShift), rooms: below.map((r) => ({ name: r.name, kind: r.kind, rect: rect(r.x, r.y, r.w, r.h, basementShift) })) });
  }

  const all = plates.flatMap((p) => p.rooms);
  const find = (...kinds: RoomKind[]) => {
    for (const k of kinds) {
      const hit = all.filter((r) => r.kind === k).sort((a, b) => area(b.rect) - area(a.rect))[0];
      if (hit) return hit;
    }
    return null;
  };
  const extras: PlanScene["extras"] = [];
  // tiles for missing rooms sit to the right of the ground floor, at its back
  let tileX = groundPlate.rect.x1 + GAP;
  const tile = (zone: Zone, label: string): Rect => {
    const r: Rect = { x0: tileX, z0: groundPlate.rect.z0, x1: tileX + TILE, z1: groundPlate.rect.z0 + TILE };
    tileX += TILE + GAP / 2;
    extras.push({ zone, rect: r, label });
    return r;
  };

  const basementRoom = find("basement", "utility");
  const garageRoom = find("garage");
  const basementRect = basementRoom?.rect ?? tile("basement", "Utility room");
  const garageRect = garageRoom?.rect ?? tile("garage", "Garage / carport");
  const front = groundPlate.rect.z1;
  const outsideRect: Rect = { x0: groundPlate.rect.x0, z0: front, x1: groundPlate.rect.x1, z1: front + OUTSIDE_DEPTH };

  const geo: InsideGeo = {
    zones: {
      basement: { label: basementRoom?.name ?? "Utility room", rect: basementRect, ...slotsIn(basementRect) },
      garage: { label: garageRoom?.name ?? "Garage / carport", rect: garageRect, ...slotsIn(garageRect) },
      // outside: against the front facade, facing the street
      outside: { label: "Outside wall", rect: outsideRect, ...slotsIn(outsideRect, front, false) },
    },
  };

  const rects = [...plates.map((p) => p.rect), ...extras.map((e) => e.rect), outsideRect];
  const box = rects.reduce((a, r) => ({ x0: Math.min(a.x0, r.x0), z0: Math.min(a.z0, r.z0), x1: Math.max(a.x1, r.x1), z1: Math.max(a.z1, r.z1) }));
  return { plates, extras, geo, centre: centreOf(box), span: Math.max(box.x1 - box.x0, (box.z1 - box.z0) * 1.6) };
}

const area = (r: Rect) => (r.x1 - r.x0) * (r.z1 - r.z0);
