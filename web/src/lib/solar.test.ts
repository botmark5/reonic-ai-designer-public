import { afterEach, describe, expect, it, vi } from "vitest";
import { clearSolarCache, handleSolarRequest, lookupSolar, roofFromSolar, type SolarResult } from "./solar";

const GEOCODE_OK = {
  status: "OK",
  results: [{ formatted_address: "Musterstraße 1, 80331 München, Germany", geometry: { location: { lat: 48.137, lng: 11.575 } } }],
};
const BUILDING = {
  center: { latitude: 48.13701, longitude: 11.57502 },
  imageryQuality: "HIGH",
  imageryDate: { year: 2022, month: 6, day: 1 },
  solarPotential: {
    maxArrayPanelsCount: 38,
    panelCapacityWatts: 400,
    maxSunshineHoursPerYear: 1180.4,
    roofSegmentStats: [
      { pitchDegrees: 34.2, azimuthDegrees: 178.9, stats: { areaMeters2: 61.3 } },
      { pitchDegrees: 33.9, azimuthDegrees: 358.6, stats: { areaMeters2: 60.8 } },
      { pitchDegrees: 12.0, azimuthDegrees: 90.0, stats: { areaMeters2: 9.5 } },
    ],
  },
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function fakeFetch(solar: () => Response) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("geocode")) return json(GEOCODE_OK);
    if (url.includes("buildingInsights")) return solar();
    throw new Error(`unexpected url ${url}`);
  });
}

afterEach(() => clearSolarCache());

describe("lookupSolar", () => {
  it("maps buildingInsights to roof segments, panels and sunshine hours", async () => {
    const f = fakeFetch(() => json(BUILDING));
    const r = await lookupSolar("Musterstraße 1, München", { key: "k", fetch: f });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.lat).toBeCloseTo(48.13701);
    expect(r.segments).toHaveLength(3);
    expect(r.segments[0]).toEqual({ pitch_deg: 34.2, azimuth_deg: 178.9, area_m2: 61.3 });
    expect(r.max_panels).toBe(38);
    expect(r.panel_watts).toBe(400);
    expect(r.sunshine_hours_year).toBe(1180);
    expect(r.imagery_quality).toBe("HIGH");
  });

  it("returns not_covered (no throw) when Solar has no building", async () => {
    const f = fakeFetch(() => json({ error: { code: 404, status: "NOT_FOUND" } }, 404));
    const r = await lookupSolar("Somewhere 1", { key: "k", fetch: f });
    expect(r.status).toBe("not_covered");
    expect(r).toMatchObject({ lat: 48.137, lng: 11.575 });
  });

  it("returns not_found when the address cannot be geocoded", async () => {
    const f = vi.fn(async () => json({ status: "ZERO_RESULTS", results: [] }));
    expect((await lookupSolar("nowhere", { key: "k", fetch: f })).status).toBe("not_found");
  });

  it("returns no_key without calling Google when the key is missing", async () => {
    const f = vi.fn();
    const r = await lookupSolar("Musterstraße 1", { key: "", fetch: f as unknown as typeof fetch });
    expect(r.status).toBe("no_key");
    expect(f).not.toHaveBeenCalled();
  });

  it("caches by normalised address", async () => {
    const f = fakeFetch(() => json(BUILDING));
    await lookupSolar("Musterstraße 1, München", { key: "k", fetch: f });
    await lookupSolar("  musterstraße 1,   MÜNCHEN ", { key: "k", fetch: f });
    expect(f).toHaveBeenCalledTimes(2); // 1 geocode + 1 solar, second lookup from cache
  });

  it("returns error (no throw) when Google fails, and does not cache the failure", async () => {
    const f = vi.fn(async () => {
      throw new Error("network down");
    });
    expect((await lookupSolar("x street", { key: "k", fetch: f })).status).toBe("error");
    await lookupSolar("x street", { key: "k", fetch: f });
    expect(f).toHaveBeenCalledTimes(2);
  });
});

describe("roofFromSolar", () => {
  it("uses the largest roof face", async () => {
    const f = fakeFetch(() => json(BUILDING));
    const r = await lookupSolar("a", { key: "k", fetch: f });
    expect(roofFromSolar(r)).toEqual({ orientation_deg: 179, tilt_deg: 34 });
  });
  it("prefers the south face of a gable roof even when the north face is a bit larger", () => {
    const r: SolarResult = {
      status: "ok", address: "a", lat: 0, lng: 0, max_panels: 0, panel_watts: 0, sunshine_hours_year: 0, imagery_quality: "HIGH",
      imagery_date: null,
      segments: [
        { pitch_deg: 40, azimuth_deg: 2, area_m2: 64 },
        { pitch_deg: 38, azimuth_deg: 182, area_m2: 60 },
        { pitch_deg: 10, azimuth_deg: 175, area_m2: 8 }, // small dormer: ignored
      ],
    };
    expect(roofFromSolar(r)).toEqual({ orientation_deg: 182, tilt_deg: 38 });
  });
  it("is null when not covered", () => {
    const miss: SolarResult = { status: "not_covered", reason: "x" };
    expect(roofFromSolar(miss)).toBeNull();
  });
});

describe("GET /api/solar", () => {
  it("429 after 20 requests a minute from one client", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 21; i++)
      codes.push((await handleSolarRequest(new Request("http://x/api/solar?address=a", { headers: { "x-forwarded-for": "1.2.3.4" } }), { key: "" })).status);
    expect(codes[19]).toBe(200);
    expect(codes[20]).toBe(429);
  });
  it("400 without address", async () => {
    const res = await handleSolarRequest(new Request("http://x/api/solar"));
    expect(res.status).toBe(400);
  });
  it("200 with a status even without a key", async () => {
    const res = await handleSolarRequest(new Request("http://x/api/solar?address=Musterstr%201"), { key: "" });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("no_key");
  });
});
