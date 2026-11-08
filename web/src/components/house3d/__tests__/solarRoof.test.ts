import { describe, expect, it } from "vitest";
import type { SolarResult } from "../../../lib/solar";
import { roofFromSolarResult } from "../solarRoof";

const ok = (segments: { pitch_deg: number; azimuth_deg: number; area_m2: number }[], max_panels = 28): SolarResult => ({
  status: "ok", address: "Musterstr. 1, München", lat: 48.1, lng: 11.6, segments, max_panels, panel_watts: 400,
  sunshine_hours_year: 1700, imagery_quality: "HIGH", imagery_date: null,
});

describe("roofFromSolarResult", () => {
  it("picks the big face closest to south, not the north face of a gable", () => {
    const r = roofFromSolarResult(ok([
      { pitch_deg: 38.2, azimuth_deg: 2, area_m2: 70 },
      { pitch_deg: 37.6, azimuth_deg: 182.4, area_m2: 69 },
      { pitch_deg: 10, azimuth_deg: 180, area_m2: 12 },
    ]));
    expect(r).toEqual({ latitude: 48.1, longitude: 11.6, pitchDeg: 38, azimuthDeg: 182, maxPanels: 28 });
  });
  it("east-west roof keeps its direction", () => {
    expect(roofFromSolarResult(ok([{ pitch_deg: 30, azimuth_deg: 92, area_m2: 50 }, { pitch_deg: 30, azimuth_deg: 272, area_m2: 50 }]))?.azimuthDeg).toBe(92);
  });
  it("ignores faces with missing numbers instead of throwing", () => {
    const r = roofFromSolarResult(ok([{ pitch_deg: 30, azimuth_deg: 180, area_m2: Number.NaN }, { pitch_deg: 32, azimuth_deg: 175, area_m2: 40 }]));
    expect(r?.azimuthDeg).toBe(175);
  });
  it("no data → undefined (defaults apply)", () => {
    expect(roofFromSolarResult(null)).toBeUndefined();
    expect(roofFromSolarResult({ status: "not_covered", reason: "no imagery" })).toBeUndefined();
  });
});
