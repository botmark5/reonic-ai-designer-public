import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { batteryModuleCount, buildEquipment } from "../equipmentGeometry";
import { HOUSE, buildHouse, countTriangles, roofPlanes, slotToWorld } from "../houseGeometry";
import { getPalette } from "../palette";

const pal = getPalette("light");
const rad = (d: number) => (d * Math.PI) / 180;

describe("roofPlanes", () => {
  it("main plane spans the house plus overhangs", () => {
    const [main, garage] = roofPlanes(35);
    expect(main.id).toBe("main");
    expect(main.width).toBeCloseTo(HOUSE.length + 2 * HOUSE.gableOverhang, 6);
    expect(main.slope).toBeCloseTo((HOUSE.depth / 2 + HOUSE.eaveOverhang) / Math.cos(rad(35)), 2);
    expect(garage.id).toBe("garage");
  });
  it("a steeper pitch gives a longer slope", () => {
    expect(roofPlanes(45)[0].slope).toBeGreaterThan(roofPlanes(35)[0].slope);
  });
});

describe("buildHouse", () => {
  const house = buildHouse(35, pal);

  it("stays well inside the triangle budget", () => {
    const tris = countTriangles(house.group);
    expect(tris).toBeGreaterThan(500);
    expect(tris).toBeLessThan(40_000);
  });

  it("slot (0,0) is the eave centre and v = slope reaches ridge height", () => {
    const main = house.frames.main;
    expect(slotToWorld(main, 0, 0).distanceTo(main.origin)).toBeLessThan(1e-9);
    const top = slotToWorld(main, 0, main.plane.slope);
    expect(top.y).toBeCloseTo(HOUSE.eaveHeight + (HOUSE.depth / 2) * Math.tan(rad(35)), 1);
    expect(Math.abs(top.z)).toBeLessThan(0.01);
  });

  it("the main plane faces south (+z) and up", () => {
    const n = house.frames.main.normal;
    expect(n.z).toBeGreaterThan(0);
    expect(n.y).toBeGreaterThan(0);
    expect(n.length()).toBeCloseTo(1, 9);
  });

  it("frames match the planes used for layout", () => {
    const planes = roofPlanes(35);
    expect(house.frames.main.plane).toEqual(planes[0]);
    expect(house.frames.garage.plane).toEqual(planes[1]);
  });
});

describe("buildEquipment", () => {
  it("builds every component plus the car within budget", () => {
    const eq = buildEquipment(pal);
    for (const k of ["inverter", "wallbox", "heatpump", "car"] as const) expect(eq[k]).toBeInstanceOf(THREE.Group);
    expect(eq.heatpump.getObjectByName("fan")).toBeDefined();
    expect(eq.car.children.filter((c) => c.name === "wheel")).toHaveLength(4);
    const total = Object.values(eq).reduce((a, g) => a + countTriangles(g), 0);
    expect(total).toBeLessThan(8_000);
  });
});

describe("batteryModuleCount", () => {
  it("stacks ≈ 2.5 kWh modules, 1 to 8", () => {
    expect([5, 7, 10, 14, 20, 30].map(batteryModuleCount)).toEqual([2, 3, 4, 6, 8, 8]);
    expect(batteryModuleCount(1)).toBe(1);
    expect(batteryModuleCount(null)).toBe(0);
    expect(batteryModuleCount(0)).toBe(0);
  });
});
