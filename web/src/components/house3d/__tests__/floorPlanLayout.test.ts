import { describe, expect, it } from "vitest";
import type { FloorPlan } from "../../../lib/floorplan";
import { planScene } from "../floorPlanLayout";
import { defaultPlacement, drop, slotPosition, zoneAt } from "../insideRules";

const plan: FloorPlan = {
  widthM: 12,
  depthM: 9,
  rooms: [
    { name: "Living room", kind: "living", x: 0, y: 4, w: 6, h: 5, floor: 0 },
    { name: "Kitchen", kind: "kitchen", x: 6, y: 4, w: 3, h: 5, floor: 0 },
    { name: "Garage", kind: "garage", x: 9, y: 0, w: 3, h: 9, floor: 0 },
    { name: "Hall", kind: "hall", x: 0, y: 0, w: 3, h: 4, floor: 0 },
    { name: "Technikraum", kind: "utility", x: 3, y: 0, w: 3, h: 4, floor: 0 },
    { name: "Bedroom", kind: "bedroom", x: 0, y: 0, w: 6, h: 4, floor: 1 },
  ],
};

const inside = (r: { x0: number; z0: number; x1: number; z1: number }, x: number, z: number) => x >= r.x0 - 1e-9 && x <= r.x1 + 1e-9 && z >= r.z0 - 1e-9 && z <= r.z1 + 1e-9;

describe("floor plan → Inside scene", () => {
  it("centres the ground floor and puts the front (drawing bottom) towards the viewer", () => {
    const s = planScene(plan);
    expect(s.plates[0].rect).toEqual({ x0: -6, z0: -4.5, x1: 6, z1: 4.5 });
    const living = s.plates[0].rooms.find((r) => r.name === "Living room")!;
    expect(living.rect.z1).toBeCloseTo(4.5); // on the front edge
  });
  it("draws the ground floor only (upper floors are not where equipment goes)", () => {
    const s = planScene(plan);
    expect(s.plates).toHaveLength(1);
    expect(s.plates[0].rooms.map((r) => r.name)).not.toContain("Bedroom");
  });
  it("snaps the zones into named rooms: utility for the basement zone, the garage, the front facade outside", () => {
    const s = planScene(plan);
    expect(s.geo.zones.basement.label).toBe("Technikraum");
    expect(s.geo.zones.garage.label).toBe("Garage");
    expect(s.extras).toHaveLength(0);
    for (const z of ["basement", "garage", "outside"] as const) {
      for (const [x, , zz] of s.geo.zones[z].slots) expect(inside(s.geo.zones[z].rect, x, zz)).toBe(true);
    }
    expect(s.geo.zones.outside.rect.z0).toBeCloseTo(4.5);
  });
  it("prefers a basement room on its own plate, and gives a missing garage a labelled tile", () => {
    const s = planScene({
      widthM: 10, depthM: 8,
      rooms: [
        { name: "Living", kind: "living", x: 0, y: 0, w: 10, h: 8, floor: 0 },
        { name: "Keller", kind: "basement", x: 0, y: 0, w: 5, h: 4, floor: -1 },
      ],
    });
    expect(s.plates.map((p) => p.title)).toEqual(["Ground floor", "Basement"]);
    expect(s.geo.zones.basement.label).toBe("Keller");
    expect(s.plates[1].rect.x1).toBeLessThan(s.plates[0].rect.x0); // to the left
    expect(s.extras.map((e) => e.zone)).toEqual(["garage"]);
    expect(s.extras[0].rect.x0).toBeGreaterThan(s.plates[0].rect.x1);
  });
  it("parts start in their rooms and a drop anywhere in a room snaps into it", () => {
    const s = planScene(plan);
    const p = defaultPlacement(["battery", "inverter", "heatpump", "wallbox"], s.geo);
    expect(p.battery?.zone).toBe("garage");
    expect(p.heatpump?.zone).toBe("outside");
    const tech = s.geo.zones.basement.rect;
    const r = drop(p, "battery", (tech.x0 + tech.x1) / 2, (tech.z0 + tech.z1) / 2, s.geo);
    expect(r.ok && r.placement.battery?.zone).toBe("basement");
    const [x, , z] = slotPosition("basement", r.ok ? r.placement.battery!.slot : 0, s.geo);
    expect(inside(tech, x, z)).toBe(true);
    // the living room is no zone: the part goes back, with a reason
    expect(zoneAt(-3, 2, s.geo)).toBeNull();
    expect(drop(p, "battery", -3, 2, s.geo).ok).toBe(false);
    // the heat pump still only goes outside
    expect(drop(p, "heatpump", (tech.x0 + tech.x1) / 2, (tech.z0 + tech.z1) / 2, s.geo).ok).toBe(false);
  });
});
