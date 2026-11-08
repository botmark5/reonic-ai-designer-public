import { decode } from "fast-png";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearSolarCache } from "./solar";
import {
  clearLayersCache, colourFlux, decodeGeoTiff, FLUX_PALETTE, handleLayersRequest, lookupLayers,
  projectedToLatLng, rampColour, rasterBounds, type Raster,
} from "./solar-layers";

// A 4 × 4 raster at 0.5 m in UTM 32N, top-left corner at E 691566, N 5334736 (around 48.137 N, 11.575 E)
const X0 = 691566, Y0 = 5334736;
/** Minimal little-endian float32 GeoTIFF (one strip, uncompressed), like Google's flux/mask layers. */
function tiff(values: number[]): ArrayBuffer {
  const w = 4, h = 4;
  const scale = [0.5, 0.5, 0];
  const tie = [0, 0, 0, X0, Y0, 0];
  const keys = [1, 1, 0, 3, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, 32632];
  const entries: [tag: number, type: number, count: number, value: number | "scale" | "tie" | "keys" | "pixels"][] = [
    [256, 4, 1, w], [257, 4, 1, h], [258, 3, 1, 32], [259, 3, 1, 1], [262, 3, 1, 1], [273, 4, 1, "pixels"],
    [277, 3, 1, 1], [278, 4, 1, h], [279, 4, 1, w * h * 4], [339, 3, 1, 3],
    [33550, 12, 3, "scale"], [33922, 12, 6, "tie"], [34735, 3, keys.length, "keys"],
  ];
  const ifdSize = 2 + entries.length * 12 + 4;
  const at = { scale: 8 + ifdSize, tie: 0, keys: 0, pixels: 0 };
  at.tie = at.scale + 24;
  at.keys = at.tie + 48;
  at.pixels = at.keys + keys.length * 2;
  const buf = new ArrayBuffer(at.pixels + w * h * 4);
  const v = new DataView(buf);
  v.setUint16(0, 0x4949); v.setUint16(2, 42, true); v.setUint32(4, 8, true);
  v.setUint16(8, entries.length, true);
  entries.forEach(([tag, type, count, value], i) => {
    const o = 10 + i * 12;
    v.setUint16(o, tag, true); v.setUint16(o + 2, type, true); v.setUint32(o + 4, count, true);
    const n = typeof value === "number" ? value : at[value];
    if (type === 3 && typeof value === "number") v.setUint16(o + 8, n, true);
    else v.setUint32(o + 8, n, true);
  });
  scale.forEach((x, i) => v.setFloat64(at.scale + i * 8, x, true));
  tie.forEach((x, i) => v.setFloat64(at.tie + i * 8, x, true));
  keys.forEach((x, i) => v.setUint16(at.keys + i * 2, x, true));
  values.forEach((x, i) => v.setFloat32(at.pixels + i * 4, x, true));
  return buf;
}
const FLUX = [
  800, 900, 1000, -9999,
  850, 950, 1050, 1100,
  700, 750, 1200, 1150,
  600, 650, 1000, 1000,
];
const MASK = [
  1, 1, 1, 1,
  1, 1, 1, 1,
  0, 0, 1, 1,
  0, 0, 1, 1,
];
const raster = (data: number[]): Raster => ({ data, width: 4, height: 4, bbox: [X0, Y0 - 2, X0 + 2, Y0], epsg: 32632 });

afterEach(() => {
  clearLayersCache();
  clearSolarCache();
});

describe("pure parts", () => {
  it("ramps cool → warm along the palette", () => {
    expect(rampColour(0)).toEqual([0x2f, 0x9f, 0xd0]);
    expect(rampColour(1)).toEqual([0xd4, 0x60, 0x4a]);
    expect(rampColour(-3)).toEqual(rampColour(0));
    expect(rampColour(NaN)).toEqual(rampColour(0));
    expect(FLUX_PALETTE).toHaveLength(6);
  });

  it("colours roof pixels only and stretches between roof percentiles", () => {
    const { rgba, min, max } = colourFlux(raster(FLUX), raster(MASK));
    const alpha = (i: number) => rgba[i * 4 + 3];
    expect(alpha(3)).toBe(0); // nodata
    expect(alpha(8)).toBe(0); // off the roof
    expect(alpha(0)).toBe(255);
    expect(min).toBe(850); // 5th percentile of the 11 roof values
    expect(max).toBe(1200); // 98th
    expect([...rgba.slice(10 * 4, 10 * 4 + 3)]).toEqual([0xd4, 0x60, 0x4a]); // 1200 ≥ max → warmest
    expect([...rgba.slice(0, 3)]).toEqual([0x2f, 0x9f, 0xd0]); // 800 < min → coolest
  });

  it("samples a mask of another resolution by nearest pixel", () => {
    const coarse: Raster = { data: [1, 0, 1, 1], width: 2, height: 2, bbox: [0, 0, 1, 1], epsg: 32632 };
    const { rgba } = colourFlux(raster(FLUX.map(() => 1000)), coarse);
    expect(rgba[0 * 4 + 3]).toBe(255);
    expect(rgba[3 * 4 + 3]).toBe(0); // top-right quadrant masked
    expect(rgba[15 * 4 + 3]).toBe(255);
  });

  it("converts UTM to lat/lng", () => {
    const p = projectedToLatLng(500000, 5000000, 32632);
    expect(p.lng).toBeCloseTo(9, 6); // central meridian of zone 32
    expect(p.lat).toBeCloseTo(45.1535, 3);
    expect(projectedToLatLng(691567.33, 5334734.33, 32632).lat).toBeCloseTo(48.137, 4);
    expect(() => projectedToLatLng(1, 1, 4326)).toThrow();
  });

  it("places the image in local metres: centre, size, grid rotation and corners", () => {
    const origin = projectedToLatLng(X0 + 1, Y0 - 1, 32632); // raster centre
    const { bounds, local } = rasterBounds(raster(FLUX), origin);
    expect(bounds.sw.lat).toBeLessThan(bounds.ne.lat);
    expect(bounds.sw.lng).toBeLessThan(bounds.ne.lng);
    expect(local.width_m).toBe(2);
    expect(local.height_m).toBe(2);
    expect(Math.abs(local.center.x_m)).toBeLessThan(0.02);
    expect(Math.abs(local.center.y_m)).toBeLessThan(0.02);
    // UTM 32 grid north at 11.575 E, 48.137 N: about +1.9° (clockwise of true north)
    expect(local.rotation_deg).toBeGreaterThan(1.8);
    expect(local.rotation_deg).toBeLessThan(2.0);
    // the north-west corner sits up-left of the centre, rotated: its x is a little less negative than -1
    expect(local.corners.nw.y_m).toBeCloseTo(1.03, 1);
    expect(local.corners.nw.x_m).toBeCloseTo(-0.97, 1);
    const d = (a: { x_m: number; y_m: number }, b: { x_m: number; y_m: number }) => Math.hypot(a.x_m - b.x_m, a.y_m - b.y_m);
    expect(d(local.corners.nw, local.corners.ne)).toBeCloseTo(2, 1);
    expect(d(local.corners.nw, local.corners.sw)).toBeCloseTo(2, 1);
  });

  it("decodes a GeoTIFF band with its bbox and EPSG", async () => {
    const r = await decodeGeoTiff(tiff(FLUX));
    expect(r).toMatchObject({ width: 4, height: 4, epsg: 32632, bbox: [X0, Y0 - 2, X0 + 2, Y0] });
    expect(Array.from(r.data).slice(0, 3)).toEqual([800, 900, 1000]);
  });
});

describe("lookupLayers / handleLayersRequest", () => {
  const meta = { annualFluxUrl: "https://solar.googleapis.com/v1/geoTiff:get?id=flux", maskUrl: "https://solar.googleapis.com/v1/geoTiff:get?id=mask", imageryQuality: "HIGH", imageryDate: { year: 2023, month: 5, day: 7 } };
  const google = () =>
    vi.fn(async (input: string | URL | Request) => {
      const u = String(input);
      if (u.includes("dataLayers:get")) return Response.json(meta);
      if (u.includes("id=flux")) return new Response(tiff(FLUX));
      if (u.includes("id=mask")) return new Response(tiff(MASK));
      throw new Error(`unexpected ${u}`);
    });
  const at = projectedToLatLng(X0 + 1, Y0 - 1, 32632);

  it("returns a PNG of the roof flux with bounds, and calls Google only once per roof", async () => {
    const f = google();
    const r = await lookupLayers(at, { key: "k", fetch: f });
    if (r.status !== "ok") throw new Error(JSON.stringify(r));
    expect(r).toMatchObject({ width: 4, height: 4, pixel_size_m: 0.5, imagery_quality: "HIGH", imagery_date: "2023-05-07", flux: { min: 850, max: 1200 } });
    expect(r.image.startsWith("data:image/png;base64,")).toBe(true);
    const png = decode(Buffer.from(r.image.split(",")[1], "base64"));
    expect([png.width, png.height, png.channels]).toEqual([4, 4, 4]);
    expect(png.data[8 * 4 + 3]).toBe(0);
    const urls = f.mock.calls.map((c) => String(c[0]));
    expect(urls[0]).toContain("radiusMeters=30");
    expect(urls[0]).toContain("view=IMAGERY_AND_ANNUAL_FLUX_LAYERS");
    expect(urls.filter((u) => u.includes("geoTiff")).every((u) => u.includes("&key=k"))).toBe(true);
    await lookupLayers(at, { key: "k", fetch: f });
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("shares one Google round trip between concurrent requests", async () => {
    const f = google();
    const [a, b] = await Promise.all([lookupLayers(at, { key: "k", fetch: f }), lookupLayers(at, { key: "k", fetch: f })]);
    expect(a.status).toBe("ok");
    expect(b).toBe(a);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("no key, not covered (cached), errors (not cached)", async () => {
    expect(await lookupLayers(at, { key: "" })).toMatchObject({ status: "no_key" });
    let n = 0;
    const f = vi.fn(async () => (++n === 1 ? new Response("x", { status: 500 }) : new Response("{}", { status: 404 })));
    expect(await lookupLayers(at, { key: "k", fetch: f })).toMatchObject({ status: "error" });
    expect(await lookupLayers(at, { key: "k", fetch: f })).toMatchObject({ status: "not_covered" });
    expect(await lookupLayers(at, { key: "k", fetch: f })).toMatchObject({ status: "not_covered" });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("handler: 400 without lat/lng, CDN cache header only on building answers, 429 after 10/min", async () => {
    const req = (q: string) => new Request(`http://x/api/solar/layers?${q}`, { headers: { "x-forwarded-for": "7.7.7.7" } });
    expect((await handleLayersRequest(req("lat=48"), { key: "k", fetch: google() })).status).toBe(400);
    const ok = await handleLayersRequest(req(`lat=${at.lat}&lng=${at.lng}`), { key: "k", fetch: google() });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toContain("s-maxage=2592000");
    const nokey = await handleLayersRequest(req(`lat=${at.lat}&lng=${at.lng}`), { key: "" });
    expect(nokey.headers.get("cache-control")).toBe("no-store");
    for (let i = 0; i < 8; i++) await handleLayersRequest(req(`lat=${at.lat}&lng=${at.lng}`), { key: "k", fetch: google() });
    expect((await handleLayersRequest(req(`lat=${at.lat}&lng=${at.lng}`), { key: "k", fetch: google() })).status).toBe(429);
  });
});
