import { describe, expect, it } from "vitest";
import { diffDesigns } from "./diff";
import type { Design } from "./types";

const base: Design = {
  pv: { include: true, kwp: 9.9, range: [8.1, 12], confidence: 0.8, reasons: [] },
  battery: { include: true, kwh: 7, range: [5, 10], confidence: 0.7, reasons: [] },
  wallbox: { include: false, kw: null, confidence: 0.6, reasons: [] },
  heatpump: { include: false, kw: null, confidence: 0.6, reasons: [] },
};
const with_ = (patch: Partial<Design>): Design => ({ ...base, ...patch });

describe("diffDesigns", () => {
  it("returns nothing for identical designs or no previous design", () => {
    expect(diffDesigns(base, base)).toEqual({ changed: [], lines: [] });
    expect(diffDesigns(null, base)).toEqual({ changed: [], lines: [] });
  });

  it("describes size changes with units, one decimal for kWp", () => {
    const d = diffDesigns(base, with_({ pv: { ...base.pv, kwp: 10.8 }, battery: { ...base.battery, kwh: 10 } }));
    expect(d.changed).toEqual(["pv", "battery"]);
    expect(d.lines).toEqual(["PV 9.9 → 10.8 kWp", "Battery 7 → 10 kWh"]);
  });

  it("describes added and removed components", () => {
    const d = diffDesigns(base, with_({
      wallbox: { ...base.wallbox, include: true, kw: 11 },
      battery: { ...base.battery, include: false, kwh: null },
    }));
    expect(d.changed).toEqual(["battery", "wallbox"]);
    expect(d.lines).toEqual(["battery removed", "wallbox added (11 kW)"]);
  });

  it("ignores float noise below the display precision", () => {
    expect(diffDesigns(base, with_({ pv: { ...base.pv, kwp: 9.900000001 } })).changed).toEqual([]);
  });
});
