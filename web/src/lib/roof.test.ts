import { describe, expect, it } from "vitest";
import { compass, roofInputsFromSolar, roofNotAsked } from "./roof";
import type { SolarResult } from "./solar";
import type { Home } from "./types";

const ok = (over: Partial<Extract<SolarResult, { status: "ok" }>> = {}): SolarResult => ({
  status: "ok", address: "x", lat: 48.1, lng: 11.5,
  segments: [
    { pitch_deg: 34.6, azimuth_deg: 0, area_m2: 60 },
    { pitch_deg: 35.2, azimuth_deg: 181, area_m2: 58 },
  ],
  max_panels: 24, panel_watts: 400, sunshine_hours_year: 1200, imagery_quality: "HIGH", imagery_date: null,
  ...over,
});

describe("roofInputsFromSolar", () => {
  it("caps PV at panels × watts and takes the south face of a gable roof", () => {
    expect(roofInputsFromSolar(ok())).toEqual({ roof_max_kwp: 9.6, roof_azimuth: 181, roof_pitch: 35 });
  });
  it("omits the cap when Google reports no panels", () => {
    expect(roofInputsFromSolar(ok({ max_panels: 0 }))?.roof_max_kwp).toBeNull();
  });
  it("returns null when Google has nothing", () => {
    expect(roofInputsFromSolar({ status: "not_covered", reason: "x" })).toBeNull();
    expect(roofInputsFromSolar(null)).toBeNull();
    expect(roofInputsFromSolar(ok({ segments: [], max_panels: 0 }))).toBeNull();
  });
});

describe("roofNotAsked / compass", () => {
  it("treats explicit null as removed by the planner", () => {
    expect(roofNotAsked({} as Home)).toBe(true);
    expect(roofNotAsked({ roof_max_kwp: null } as Home)).toBe(false);
  });
  it("names directions", () => {
    expect(compass(180)).toBe("south");
    expect(compass(225)).toBe("south-west");
    expect(compass(359)).toBe("north");
    expect(compass(null)).toBeNull();
  });
});
