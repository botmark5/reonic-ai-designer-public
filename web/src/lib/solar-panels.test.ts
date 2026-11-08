import { afterEach, describe, expect, it, vi } from "vitest";
import { clearSolarCache } from "./solar";
import { clearPanelsCache, handlePanelsRequest, lookupPanels, PANEL_KWP, placePanels, toLocal } from "./solar-panels";

const C = { latitude: 48.137, longitude: 11.575 };
// 12 panels, best first, on two segments (0 = south face, 1 = north face)
const PANELS = Array.from({ length: 12 }, (_, i) => ({
  center: { latitude: C.latitude + (i < 8 ? -0.00002 : 0.00002), longitude: C.longitude + (i % 8) * 0.00001 },
  orientation: i % 2 ? "PORTRAIT" : "LANDSCAPE",
  segmentIndex: i < 8 ? 0 : 1,
  yearlyEnergyDcKwh: 500 - i * 10,
}));
const INSIGHTS = {
  center: C,
  boundingBox: { sw: { latitude: 48.1369, longitude: 11.5749 }, ne: { latitude: 48.1371, longitude: 11.5751 } },
  imageryQuality: "HIGH",
  solarPotential: {
    panelCapacityWatts: 400,
    panelHeightMeters: 1.879,
    panelWidthMeters: 1.045,
    maxArrayPanelsCount: 12,
    roofSegmentStats: [
      {
        pitchDegrees: 34.2, azimuthDegrees: 178.9, stats: { areaMeters2: 61.3 },
        center: { latitude: 48.13698, longitude: 11.575 },
        boundingBox: { sw: { latitude: 48.13695, longitude: 11.57495 }, ne: { latitude: 48.137, longitude: 11.57505 } },
        planeHeightAtCenterMeters: 7.4,
      },
      {
        pitchDegrees: 33.9, azimuthDegrees: 358.6, stats: { areaMeters2: 60.8 },
        center: { latitude: 48.13702, longitude: 11.575 },
        boundingBox: { sw: { latitude: 48.137, longitude: 11.57495 }, ne: { latitude: 48.13705, longitude: 11.57505 } },
        planeHeightAtCenterMeters: 7.3,
      },
    ],
    solarPanels: PANELS,
  },
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => {
  clearPanelsCache();
  clearSolarCache();
});

describe("toLocal", () => {
  it("gives east/north metres from the origin", () => {
    const p = toLocal({ lat: 48.137 + 0.0001, lng: 11.575 + 0.0001 }, { lat: 48.137, lng: 11.575 });
    expect(p.y_m).toBeCloseTo(11.1, 1); // 0.0001° lat ≈ 11.1 m
    expect(p.x_m).toBeCloseTo(7.4, 1); // 0.0001° lng × cos(48.137°) ≈ 7.4 m
  });
});

describe("placePanels", () => {
  it("takes N = round(kWp / 0.45) best panels in Google's order", () => {
    const r = placePanels(INSIGHTS, 3.6);
    expect(PANEL_KWP).toBe(0.45);
    expect(r.panel_count).toBe(8);
    expect(r.placed_kwp).toBe(3.6);
    expect(r.capped).toBe(false);
    expect(r.panels.map((p) => p.yearly_kwh)).toEqual([500, 490, 480, 470, 460, 450, 440, 430]);
    expect(r.panels[0]).toMatchObject({ orientation: "LANDSCAPE", segment_index: 0, lat: PANELS[0].center.latitude, lng: PANELS[0].center.longitude });
    expect(r.panels[1].orientation).toBe("PORTRAIT");
    expect(r.panels[0].y_m).toBeCloseTo(-2.2, 1);
  });

  it("fills the best roof face contiguously before starting the next (no scattered pairs)", () => {
    // Google's best-first list alternates between a small dormer (seg 2: 3 panels) and the main face (seg 0: 10 panels)
    const p = (seg: number, kwh: number) => ({ center: C, orientation: "LANDSCAPE", segmentIndex: seg, yearlyEnergyDcKwh: kwh });
    const mixed = {
      center: C,
      solarPotential: {
        roofSegmentStats: [{}, {}, {}],
        solarPanels: [p(2, 520), p(0, 510), p(2, 505), p(0, 500), p(2, 495), ...Array.from({ length: 8 }, (_, i) => p(0, 490 - i))],
      },
    };
    const r = placePanels(mixed, 6 * 0.45);
    expect(r.panels.map((x) => x.segment_index)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(r.panels.map((x) => x.yearly_kwh)).toEqual([510, 500, 490, 489, 488, 487]);
    // more than the main face holds: it fills up first, then the next best face
    const big = placePanels(mixed, 12 * 0.45);
    expect(big.panels.map((x) => x.segment_index)).toEqual([...Array(10).fill(0), 2, 2]);
    expect(big.segments[0].panel_count).toBe(10);
  });

  it("rounds the panel count and caps at what fits on the roof", () => {
    expect(placePanels(INSIGHTS, 1.0).panel_count).toBe(2); // 2.22 → 2
    const big = placePanels(INSIGHTS, 20);
    expect(big).toMatchObject({ requested_panels: 44, panel_count: 12, capped: true, placed_kwp: 5.4 });
    expect(placePanels(INSIGHTS, 0)).toMatchObject({ panel_count: 0, panels: [] });
  });

  it("returns the roof segments with geometry, and the panel size", () => {
    const r = placePanels(INSIGHTS, 3.6);
    expect(r.panel_size).toEqual({ width_m: 1.045, height_m: 1.879 });
    expect(r.center).toEqual({ lat: 48.137, lng: 11.575 });
    expect(r.segments).toHaveLength(2);
    expect(r.segments[0]).toMatchObject({
      index: 0, pitch_deg: 34.2, azimuth_deg: 178.9, area_m2: 61.3, plane_height_m: 7.4,
      center: { lat: 48.13698, lng: 11.575 },
      bbox: { sw: { lat: 48.13695, lng: 11.57495 }, ne: { lat: 48.137, lng: 11.57505 } },
      panel_count: 8,
    });
    expect(r.segments[1]).toMatchObject({ panel_count: 0, plane_height_rel_m: 0 });
    expect(r.segments[0].plane_height_rel_m).toBe(0.1);
    expect(r.segments[0].center.y_m).toBeCloseTo(-2.2, 1);
    expect(r.building_bbox).toEqual({ sw: { lat: 48.1369, lng: 11.5749 }, ne: { lat: 48.1371, lng: 11.5751 } });
  });

  it("copes with a building without panel data", () => {
    const r = placePanels({ center: C, solarPotential: {} }, 5);
    expect(r).toMatchObject({ panel_count: 0, capped: true, segments: [], panels: [] });
  });
});

describe("lookupPanels / handlePanelsRequest", () => {
  it("answers no_key without a key", async () => {
    expect(await lookupPanels({ lat: 48.137, lng: 11.575, kwp: 5 }, { key: "" })).toMatchObject({ status: "no_key" });
  });

  it("fetches buildingInsights once per building and reuses it for any kWp", async () => {
    const f = vi.fn(async () => json(INSIGHTS));
    const a = await lookupPanels({ lat: 48.137, lng: 11.575, kwp: 3.6 }, { key: "k", fetch: f });
    const b = await lookupPanels({ lat: 48.137, lng: 11.575, kwp: 1 }, { key: "k", fetch: f });
    expect(a).toMatchObject({ status: "ok", panel_count: 8, imagery_quality: "HIGH" });
    expect(b).toMatchObject({ status: "ok", panel_count: 2 });
    expect(f).toHaveBeenCalledTimes(1);
    const url = String((f.mock.calls[0] as unknown[])[0]);
    expect(url).toContain("buildingInsights:findClosest");
    expect(url).toContain("location.latitude=48.137");
  });

  it("maps a 404 to not_covered and does not cache errors", async () => {
    let n = 0;
    const f = vi.fn(async () => (++n === 1 ? json({}, 500) : json({}, 404)));
    expect(await lookupPanels({ lat: 1, lng: 2, kwp: 5 }, { key: "k", fetch: f })).toMatchObject({ status: "error" });
    expect(await lookupPanels({ lat: 1, lng: 2, kwp: 5 }, { key: "k", fetch: f })).toMatchObject({ status: "not_covered" });
    expect(await lookupPanels({ lat: 1, lng: 2, kwp: 5 }, { key: "k", fetch: f })).toMatchObject({ status: "not_covered" });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("validates lat, lng and kwp", async () => {
    const call = (q: string) => handlePanelsRequest(new Request(`http://x/api/solar/panels?${q}`), { key: "k", fetch: vi.fn() });
    expect((await call("lat=48&lng=11")).status).toBe(400);
    expect((await call("lat=91&lng=11&kwp=5")).status).toBe(400);
    expect((await call("lat=48&lng=abc&kwp=5")).status).toBe(400);
    expect((await call("lat=48&lng=11&kwp=-1")).status).toBe(400);
    expect((await call("lat=48&lng=11&kwp=500")).status).toBe(400);
  });

  it("accepts an address instead of lat/lng (geocoded through the Solar lookup)", async () => {
    const f = vi.fn(async (input: string | URL | Request) => {
      const u = String(input);
      if (u.includes("geocode")) return json({ status: "OK", results: [{ formatted_address: "X", geometry: { location: { lat: 48.137, lng: 11.575 } } }] });
      return json(INSIGHTS);
    });
    const res = await handlePanelsRequest(new Request("http://x/api/solar/panels?address=Musterstr%201&kwp=3.6"), { key: "k", fetch: f });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok", panel_count: 8 });
  });

  it("rate limits at 20 per minute per client", async () => {
    const f = vi.fn(async () => json(INSIGHTS));
    const req = () => new Request("http://x/api/solar/panels?lat=48.137&lng=11.575&kwp=3", { headers: { "x-forwarded-for": "9.9.9.9" } });
    for (let i = 0; i < 20; i++) expect((await handlePanelsRequest(req(), { key: "k", fetch: f })).status).toBe(200);
    expect((await handlePanelsRequest(req(), { key: "k", fetch: f })).status).toBe(429);
  });
});
