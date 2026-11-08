import { describe, expect, it } from "vitest";
import { sanitizeFloorPlan } from "./floorplan";

describe("sanitizeFloorPlan", () => {
  it("keeps a clean plan as is", () => {
    const p = sanitizeFloorPlan({ widthM: 10, depthM: 8, rooms: [{ name: "Garage", kind: "garage", x: 0, y: 0, w: 3, h: 6, floor: 0 }] });
    expect(p).toEqual({ widthM: 10, depthM: 8, rooms: [{ name: "Garage", kind: "garage", x: 0, y: 0, w: 3, h: 6, floor: 0 }] });
  });

  it("clamps rooms into the footprint, fixes floor and kind, rounds to cm", () => {
    const p = sanitizeFloorPlan({
      widthM: 10,
      depthM: 8,
      rooms: [{ name: "  Living room  ", kind: "salon", x: -1, y: 7.5, w: 14.333, h: 3, floor: 3 }],
    });
    expect(p?.rooms[0]).toEqual({ name: "Living room", kind: "other", x: 0, y: 7.5, w: 10, h: 0.5, floor: 0 });
  });

  it("drops rooms without a name or with no area, and caps the count", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ name: `R${i}`, kind: "other", x: 0, y: 0, w: 1, h: 1, floor: 0 }));
    expect(sanitizeFloorPlan({ widthM: 10, depthM: 8, rooms: many })?.rooms).toHaveLength(40);
    const p = sanitizeFloorPlan({ widthM: 10, depthM: 8, rooms: [{ name: "", kind: "hall", x: 0, y: 0, w: 2, h: 2, floor: 0 }, { name: "Bath", kind: "bath", x: 10, y: 0, w: 2, h: 2, floor: 0 }, { name: "Hall", kind: "hall", x: 1, y: 1, w: 2, h: 2, floor: 0 }] });
    expect(p?.rooms.map((r) => r.name)).toEqual(["Hall"]);
  });

  it("rejects garbage and implausible footprints", () => {
    expect(sanitizeFloorPlan(null)).toBeNull();
    expect(sanitizeFloorPlan({ widthM: "x", depthM: 8, rooms: [] })).toBeNull();
    expect(sanitizeFloorPlan({ widthM: 10, depthM: 8, rooms: [] })).toBeNull();
    expect(sanitizeFloorPlan({ widthM: 500, depthM: 8, rooms: [{ name: "A", kind: "other", x: 0, y: 0, w: 1, h: 1, floor: 0 }] })).toBeNull();
  });

  it("truncates long names", () => {
    const p = sanitizeFloorPlan({ widthM: 10, depthM: 8, rooms: [{ name: "x".repeat(80), kind: "other", x: 0, y: 0, w: 1, h: 1, floor: -1 }] });
    expect(p?.rooms[0].name).toHaveLength(40);
    expect(p?.rooms[0].floor).toBe(-1);
  });
});
