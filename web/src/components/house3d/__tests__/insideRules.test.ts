import { describe, expect, it } from "vitest";
import { defaultPlacement, drop, freeSlot, moveTo, slotPosition, zoneAt } from "../insideRules";

describe("inside rules", () => {
  it("defaults: battery, inverter and wallbox in the garage, heat pump outside, all in different slots", () => {
    const p = defaultPlacement(["battery", "inverter", "heatpump", "wallbox"]);
    expect(p.battery?.zone).toBe("garage");
    expect(p.heatpump?.zone).toBe("outside");
    const garageSlots = [p.battery, p.inverter, p.wallbox].map((x) => x?.slot);
    expect(new Set(garageSlots).size).toBe(3);
  });
  it("zones by x, gaps between them are nowhere", () => {
    expect(zoneAt(-4)).toBe("basement");
    expect(zoneAt(0)).toBe("garage");
    expect(zoneAt(4)).toBe("outside");
    expect(zoneAt(-1.75)).toBeNull();
  });
  it("the heat pump cannot go indoors", () => {
    const p = defaultPlacement(["heatpump"]);
    const r = drop(p, "heatpump", 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/outside air/);
  });
  it("the battery moves to the basement and snaps to the nearest free slot", () => {
    const p = defaultPlacement(["battery"]);
    const r = drop(p, "battery", -2.7);
    expect(r.ok && r.placement.battery).toEqual({ zone: "basement", slot: 2 });
  });
  it("a full zone says so", () => {
    let p = defaultPlacement(["battery", "inverter", "wallbox"]);
    const r = moveTo(p, "heatpump", "garage");
    expect(r.ok).toBe(false);
    p = { battery: { zone: "basement", slot: 0 }, inverter: { zone: "basement", slot: 1 } };
    expect(freeSlot(p, "basement", -4.4)).toBe(2);
  });
  it("moving within a zone frees its own slot", () => {
    const p = { battery: { zone: "garage" as const, slot: 0 } };
    expect(freeSlot(p, "garage", -1.0, "battery")).toBe(0);
  });
  it("basement items stand on the sunk floor", () => {
    expect(slotPosition("basement", 0)[1]).toBeLessThan(0);
  });
});
