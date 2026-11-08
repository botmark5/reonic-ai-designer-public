/**
 * Sun-map overlay for the 3D house: Google Solar dataLayers (annual flux + roof mask, GeoTIFF in UTM)
 * → a coloured PNG (cool → warm, transparent off the roof) plus its geographic bounds.
 * Server-only (GOOGLE_MAPS_API_KEY). Never throws: failures are statuses. Cached hard (memory + CDN headers),
 * because each lookup costs three Google requests.
 */
import "server-only";
import { encode } from "fast-png";
import { fromArrayBuffer } from "geotiff";
import proj4 from "proj4";
import { allowRequest, clientKey } from "./solar";
import { toLocal, type Bbox, type LatLng } from "./solar-panels";

export const LAYER_RADIUS_M = 30;
export const LAYER_PIXEL_M = 0.5;
const DAY_MS = 24 * 3600 * 1000;
const CACHE_MS = 30 * DAY_MS;
const MAX_CACHE = 50;

/** Cool → warm, from the app's palette (battery blue → sky → highlight → PV amber → orange → heat-pump red). */
export const FLUX_PALETTE = ["#2f9fd0", "#53bdeb", "#f2d473", "#e9a23b", "#ef8a4c", "#d4604a"];

export interface Raster {
  data: ArrayLike<number>;
  width: number;
  height: number;
  /** [minX, minY, maxX, maxY] in the raster's projected metres */
  bbox: [number, number, number, number];
  epsg: number | null;
}

export interface LayersOk {
  status: "ok";
  /** data:image/png;base64,… RGBA, north up, row 0 = north edge */
  image: string;
  width: number;
  height: number;
  pixel_size_m: number;
  /** request point the local metres are measured from (pass /api/solar/panels' `center` to line both up) */
  origin: LatLng;
  bounds: Bbox;
  /**
   * Where the image lies, in metres east (x) / north (y) of origin. The image is a UTM square, rotated by
   * `rotation_deg` (its "up" points that many degrees clockwise of true north; ~2° in Munich). Use `corners`
   * for an exact quad, or a width × height plane at `center` rotated by -rotation_deg around the vertical.
   */
  local: LocalPlacement;
  /** legend: colour scale ends, kWh per kW of panels per year */
  flux: { min: number; max: number; unit: "kWh/kW/year" };
  palette: string[];
  imagery_quality: string;
  imagery_date: string | null;
}
export interface Pt { x_m: number; y_m: number }
export interface LocalPlacement {
  center: Pt;
  width_m: number;
  height_m: number;
  rotation_deg: number;
  corners: { nw: Pt; ne: Pt; se: Pt; sw: Pt };
}

export type LayersResult = LayersOk | { status: "not_covered" | "no_key" | "error"; reason: string };

// ---------------------------------------------------------------------------
// pure parts
// ---------------------------------------------------------------------------
const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

/** Palette lookup for t in [0, 1], linear between stops. */
export function rampColour(t: number, palette = FLUX_PALETTE): [number, number, number] {
  const x = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0)) * (palette.length - 1);
  const i = Math.min(palette.length - 2, Math.floor(x));
  const a = hex(palette[i]);
  const b = hex(palette[i + 1]);
  const f = x - i;
  return [0, 1, 2].map((k) => Math.round(a[k] + (b[k] - a[k]) * f)) as [number, number, number];
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];
}

/**
 * RGBA pixels for the flux raster: roof pixels (mask ≠ 0, flux valid) get the ramp between the 5th and 98th
 * percentile of roof flux; everything else is transparent. The mask may have another resolution (nearest pixel).
 */
export function colourFlux(flux: Raster, mask: Raster | null): { rgba: Uint8Array; min: number; max: number } {
  const { width: w, height: h } = flux;
  const onRoof = (x: number, y: number) => {
    if (!mask) return true;
    const mx = Math.min(mask.width - 1, Math.floor(((x + 0.5) * mask.width) / w));
    const my = Math.min(mask.height - 1, Math.floor(((y + 0.5) * mask.height) / h));
    return mask.data[my * mask.width + mx] > 0;
  };
  const valid = (v: number) => Number.isFinite(v) && v > -9000; // Google nodata = -9999
  const roofValues: number[] = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = flux.data[y * w + x];
      if (valid(v) && onRoof(x, y)) roofValues.push(v);
    }
  roofValues.sort((a, b) => a - b);
  const min = percentile(roofValues, 0.05);
  const max = percentile(roofValues, 0.98);
  const span = max - min || 1;
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = flux.data[y * w + x];
      if (!valid(v) || !onRoof(x, y)) continue;
      const [r, g, b] = rampColour((v - min) / span);
      const o = (y * w + x) * 4;
      rgba[o] = r;
      rgba[o + 1] = g;
      rgba[o + 2] = b;
      rgba[o + 3] = 255;
    }
  return { rgba, min: Math.round(min), max: Math.round(max) };
}

/** Projected (UTM, EPSG 326zz north / 327zz south) → WGS84. */
export function projectedToLatLng(x: number, y: number, epsg: number): LatLng {
  const zone = epsg % 100;
  const south = Math.floor(epsg / 100) === 327;
  if (!(Math.floor(epsg / 100) === 326 || south) || zone < 1 || zone > 60) throw new Error(`Unsupported projection EPSG:${epsg}`);
  const [lng, lat] = proj4(`+proj=utm +zone=${zone}${south ? " +south" : ""} +datum=WGS84 +units=m +no_defs`, "WGS84", [x, y]);
  return { lat, lng };
}

/** Bounds of a projected raster: lat/lng envelope (sw/ne corners) and exact placement in local metres around `origin`. */
export function rasterBounds(r: Raster, origin: LatLng): { bounds: Bbox; local: LocalPlacement } {
  if (r.epsg == null) throw new Error("GeoTIFF has no projected CRS");
  const epsg = r.epsg;
  const [x0, y0, x1, y1] = r.bbox;
  const at = (x: number, y: number) => toLocal(projectedToLatLng(x, y, epsg), origin);
  const corners = { nw: at(x0, y1), ne: at(x1, y1), se: at(x1, y0), sw: at(x0, y0) };
  const center = at((x0 + x1) / 2, (y0 + y1) / 2);
  // grid north vs true north: bearing of a 100 m step up the grid from the centre (unrounded)
  const c0 = projectedToLatLng((x0 + x1) / 2, (y0 + y1) / 2, epsg);
  const c1 = projectedToLatLng((x0 + x1) / 2, (y0 + y1) / 2 + 100, epsg);
  const east = (c1.lng - c0.lng) * Math.cos((c0.lat * Math.PI) / 180);
  const rotation_deg = Math.round(((Math.atan2(east, c1.lat - c0.lat) * 180) / Math.PI) * 100) / 100;
  return {
    bounds: { sw: projectedToLatLng(x0, y0, epsg), ne: projectedToLatLng(x1, y1, epsg) },
    local: { center, width_m: Math.round((x1 - x0) * 100) / 100, height_m: Math.round((y1 - y0) * 100) / 100, rotation_deg, corners },
  };
}

/** First band of a GeoTIFF, with its projected bbox and EPSG code. */
export async function decodeGeoTiff(buf: ArrayBuffer): Promise<Raster> {
  const tiff = await fromArrayBuffer(buf);
  const img = await tiff.getImage();
  const [band] = (await img.readRasters({ samples: [0] })) as unknown as ArrayLike<number>[];
  const keys = img.getGeoKeys() as { ProjectedCSTypeGeoKey?: number } | null;
  return {
    data: band,
    width: img.getWidth(),
    height: img.getHeight(),
    bbox: img.getBoundingBox() as [number, number, number, number],
    epsg: keys?.ProjectedCSTypeGeoKey ?? null,
  };
}

export function toPngDataUrl(rgba: Uint8Array, width: number, height: number): string {
  const png = encode({ width, height, data: rgba, channels: 4, depth: 8 });
  return `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
}

// ---------------------------------------------------------------------------
// Google + cache
// ---------------------------------------------------------------------------
export interface LayersOptions {
  key?: string;
  fetch?: typeof fetch;
}
type Cached = LayersOk | { status: "not_covered"; reason: string };
const cache = new Map<string, { at: number; value: Cached }>();
const inflight = new Map<string, Promise<LayersResult>>();

export function clearLayersCache() {
  cache.clear();
  inflight.clear();
}

const cacheKey = (lat: number, lng: number) => `${lat.toFixed(5)},${lng.toFixed(5)}`;

export async function lookupLayers(at: LatLng, opts: LayersOptions = {}): Promise<LayersResult> {
  const key = opts.key ?? process.env.GOOGLE_MAPS_API_KEY ?? "";
  if (!key) return { status: "no_key", reason: "GOOGLE_MAPS_API_KEY is not set." };
  const k = cacheKey(at.lat, at.lng);
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  // Concurrent requests for the same roof share one Google round trip.
  const running = inflight.get(k);
  if (running) return running;
  const p = fetchLayers(at, key, opts.fetch ?? fetch)
    .catch((e): LayersResult => ({ status: "error", reason: e instanceof Error ? e.message : "Solar layers failed." }))
    .then((value) => {
      if (value.status === "ok" || value.status === "not_covered") {
        if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value as string);
        cache.set(k, { at: Date.now(), value: value as Cached });
      }
      return value;
    })
    .finally(() => inflight.delete(k));
  inflight.set(k, p);
  return p;
}

async function fetchLayers(at: LatLng, key: string, f: typeof fetch): Promise<LayersResult> {
  const url = new URL("https://solar.googleapis.com/v1/dataLayers:get");
  url.searchParams.set("location.latitude", String(at.lat));
  url.searchParams.set("location.longitude", String(at.lng));
  url.searchParams.set("radiusMeters", String(LAYER_RADIUS_M));
  url.searchParams.set("view", "IMAGERY_AND_ANNUAL_FLUX_LAYERS");
  url.searchParams.set("requiredQuality", "LOW");
  url.searchParams.set("pixelSizeMeters", String(LAYER_PIXEL_M));
  url.searchParams.set("key", key);
  const res = await f(url);
  if (res.status === 404) return { status: "not_covered", reason: "Google Solar has no data layers for this place." };
  if (!res.ok) return { status: "error", reason: `Solar dataLayers failed (${res.status}).` };
  const meta = (await res.json()) as {
    annualFluxUrl?: string; maskUrl?: string; imageryQuality?: string;
    imageryDate?: { year: number; month: number; day: number };
  };
  if (!meta.annualFluxUrl) return { status: "error", reason: "No annual flux layer in the answer." };
  const tiff = async (u: string) => {
    const r = await f(`${u}${u.includes("?") ? "&" : "?"}key=${encodeURIComponent(key)}`);
    if (!r.ok) throw new Error(`GeoTIFF download failed (${r.status}).`);
    return decodeGeoTiff(await r.arrayBuffer());
  };
  const [flux, mask] = await Promise.all([tiff(meta.annualFluxUrl), meta.maskUrl ? tiff(meta.maskUrl) : Promise.resolve(null)]);
  const { rgba, min, max } = colourFlux(flux, mask);
  const { bounds, local } = rasterBounds(flux, at);
  const d = meta.imageryDate;
  return {
    status: "ok",
    image: toPngDataUrl(rgba, flux.width, flux.height),
    width: flux.width,
    height: flux.height,
    pixel_size_m: Math.round(((flux.bbox[2] - flux.bbox[0]) / flux.width) * 100) / 100,
    origin: at,
    bounds,
    local,
    flux: { min, max, unit: "kWh/kW/year" },
    palette: FLUX_PALETTE,
    imagery_quality: meta.imageryQuality ?? "UNKNOWN",
    imagery_date: d ? `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}` : null,
  };
}

const num = (v: string | null) => (v == null || v.trim() === "" ? NaN : Number(v));

/** GET /api/solar/layers?lat=&lng= → 200 LayersResult (CDN-cached when it describes the building); 400; 429. */
export async function handleLayersRequest(req: Request, opts: LayersOptions = {}): Promise<Response> {
  const q = new URL(req.url).searchParams;
  const lat = num(q.get("lat"));
  const lng = num(q.get("lng"));
  if (!(Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) return Response.json({ error: "lat and lng are required" }, { status: 400 });
  if (!allowRequest("solar-layers", clientKey(req), 10, 60_000)) return Response.json({ error: "too many requests" }, { status: 429 });
  const r = await lookupLayers({ lat, lng }, opts);
  const cacheable = r.status === "ok" || r.status === "not_covered";
  return Response.json(r, {
    headers: { "cache-control": cacheable ? "public, max-age=86400, s-maxage=2592000, immutable" : "no-store" },
  });
}
