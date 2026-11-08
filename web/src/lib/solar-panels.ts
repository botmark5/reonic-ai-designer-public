/**
 * Panel placement for the 3D house: Google Solar buildingInsights → the N best panels for a design's kWp,
 * plus the roof segments' geometry. Server-only (GOOGLE_MAPS_API_KEY). Never throws: failures are statuses.
 * buildingInsights is cached per building (24 h) so any kWp change reuses it.
 */
import "server-only";
import { allowRequest, clientKey, lookupSolar } from "./solar";

/** kWp per panel the installers sell (Google's own panel is smaller; we only borrow its positions). */
export const PANEL_KWP = 0.45;
const MAX_KWP = 100;
const DAY_MS = 24 * 3600 * 1000;
const MAX_CACHE = 200;

export interface LatLng { lat: number; lng: number }
export interface Local { x_m: number; y_m: number } // metres east / north of the building centre
export interface Bbox { sw: LatLng; ne: LatLng }

export interface PlacedPanel extends LatLng, Local {
  orientation: "LANDSCAPE" | "PORTRAIT";
  segment_index: number;
  yearly_kwh: number; // Google's DC estimate for its own panel; use for ranking/heat, not for the offer
}

export interface PanelSegment {
  index: number;
  pitch_deg: number;
  azimuth_deg: number; // compass: 180 = south
  area_m2: number;
  plane_height_m: number | null; // Google: roof plane height in metres ABOVE SEA LEVEL at the segment centre
  plane_height_rel_m: number | null; // the same, relative to the building's lowest roof segment (0 = lowest)
  center: LatLng & Local;
  bbox: Bbox | null;
  panel_count: number; // of the placed panels
}

export interface Placement {
  center: LatLng;
  building_bbox: Bbox | null;
  panel_kwp: number;
  panel_size: { width_m: number; height_m: number };
  requested_kwp: number;
  requested_panels: number;
  panel_count: number;
  placed_kwp: number;
  capped: boolean; // the roof holds fewer panels than requested
  max_panels: number;
  segments: PanelSegment[];
  panels: PlacedPanel[];
}

export type PanelsResult =
  | ({ status: "ok"; imagery_quality: string } & Placement)
  | { status: "not_covered" | "not_found" | "no_key" | "error"; reason: string };

// --- Google types (only what we read) ---------------------------------------
interface GLatLng { latitude?: number; longitude?: number }
interface GBox { sw?: GLatLng; ne?: GLatLng }
export interface Insights {
  center?: GLatLng;
  boundingBox?: GBox;
  imageryQuality?: string;
  solarPotential?: {
    panelHeightMeters?: number;
    panelWidthMeters?: number;
    maxArrayPanelsCount?: number;
    roofSegmentStats?: {
      pitchDegrees?: number; azimuthDegrees?: number; stats?: { areaMeters2?: number };
      center?: GLatLng; boundingBox?: GBox; planeHeightAtCenterMeters?: number;
    }[];
    solarPanels?: { center?: GLatLng; orientation?: string; segmentIndex?: number; yearlyEnergyDcKwh?: number }[];
  };
}

const ll = (p?: GLatLng): LatLng => ({ lat: p?.latitude ?? 0, lng: p?.longitude ?? 0 });
const box = (b?: GBox): Bbox | null => (b?.sw && b?.ne ? { sw: ll(b.sw), ne: ll(b.ne) } : null);
const r2 = (x: number) => Math.round(x * 100) / 100;

/** Equirectangular metres east (x) / north (y) of `origin`; exact enough over one roof. */
export function toLocal(p: LatLng, origin: LatLng): Local {
  const y = (p.lat - origin.lat) * 111_320;
  const x = (p.lng - origin.lng) * 111_320 * Math.cos((origin.lat * Math.PI) / 180);
  return { x_m: r2(x), y_m: r2(y) };
}

type GPanel = NonNullable<NonNullable<Insights["solarPotential"]>["solarPanels"]>[number];

/**
 * N panels the way an installer fills a roof: the best face first, contiguously, then the next face. A face's score is
 * the energy of the panels it would take (its best min(N, size) panels), so one big good face beats scattered pairs on
 * small dormers. Within a face, Google's best-first order is kept.
 */
export function fillContiguously(all: GPanel[], n: number): GPanel[] {
  if (n <= 0) return [];
  const faces = new Map<number, GPanel[]>();
  for (const p of all) {
    const k = p.segmentIndex ?? 0;
    const list = faces.get(k);
    if (list) list.push(p);
    else faces.set(k, [p]);
  }
  const score = (list: GPanel[]) => list.slice(0, n).reduce((sum, p) => sum + (p.yearlyEnergyDcKwh ?? 0), 0);
  const ranked = [...faces.values()].sort((a, b) => score(b) - score(a)); // stable: ties keep Google's order
  const out: GPanel[] = [];
  for (const list of ranked) {
    for (const p of list) {
      if (out.length >= n) return out;
      out.push(p);
    }
  }
  return out;
}

/** Pure: N = round(kWp / 0.45) panels, filled face by face (best face first), capped at what fits. */
export function placePanels(b: Insights, kwp: number): Placement {
  const sp = b.solarPotential ?? {};
  const center = ll(b.center);
  const all = sp.solarPanels ?? [];
  const requested = Math.max(0, Math.round(kwp / PANEL_KWP));
  const panels: PlacedPanel[] = fillContiguously(all, requested).map((p) => {
    const at = ll(p.center);
    return {
      ...at,
      ...toLocal(at, center),
      orientation: p.orientation === "PORTRAIT" ? "PORTRAIT" : "LANDSCAPE",
      segment_index: p.segmentIndex ?? 0,
      yearly_kwh: Math.round(p.yearlyEnergyDcKwh ?? 0),
    };
  });
  const heights = (sp.roofSegmentStats ?? []).map((s) => s.planeHeightAtCenterMeters).filter((h): h is number => typeof h === "number");
  const lowest = heights.length ? Math.min(...heights) : null;
  const segments: PanelSegment[] = (sp.roofSegmentStats ?? []).map((s, index) => {
    const c = ll(s.center);
    return {
      index,
      pitch_deg: s.pitchDegrees ?? 0,
      azimuth_deg: s.azimuthDegrees ?? 0,
      area_m2: s.stats?.areaMeters2 ?? 0,
      plane_height_m: s.planeHeightAtCenterMeters ?? null,
      plane_height_rel_m: s.planeHeightAtCenterMeters != null && lowest != null ? r2(s.planeHeightAtCenterMeters - lowest) : null,
      center: { ...c, ...toLocal(c, center) },
      bbox: box(s.boundingBox),
      panel_count: panels.filter((p) => p.segment_index === index).length,
    };
  });
  return {
    center,
    building_bbox: box(b.boundingBox),
    panel_kwp: PANEL_KWP,
    panel_size: { width_m: sp.panelWidthMeters ?? 1.045, height_m: sp.panelHeightMeters ?? 1.879 },
    requested_kwp: kwp,
    requested_panels: requested,
    panel_count: panels.length,
    placed_kwp: r2(panels.length * PANEL_KWP),
    capped: panels.length < requested,
    max_panels: sp.maxArrayPanelsCount ?? all.length,
    segments,
    panels,
  };
}

// --- buildingInsights by location, cached -----------------------------------
type Fetched = { status: "ok"; insights: Insights } | { status: "not_covered" | "error"; reason: string };
const cache = new Map<string, { at: number; value: Fetched }>();

export function clearPanelsCache() {
  cache.clear();
}

export interface PanelsOptions {
  key?: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

async function insightsAt(lat: number, lng: number, key: string, opts: PanelsOptions): Promise<Fetched> {
  const k = `${lat.toFixed(5)},${lng.toFixed(5)}`; // ~1 m
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < DAY_MS) return hit.value;
  let value: Fetched;
  try {
    const url = new URL("https://solar.googleapis.com/v1/buildingInsights:findClosest");
    url.searchParams.set("location.latitude", String(lat));
    url.searchParams.set("location.longitude", String(lng));
    url.searchParams.set("requiredQuality", "LOW");
    url.searchParams.set("key", key);
    const res = await (opts.fetch ?? fetch)(url, { signal: opts.signal });
    if (res.status === 404) value = { status: "not_covered", reason: "Google Solar has no data for this building." };
    else if (!res.ok) value = { status: "error", reason: `Solar API failed (${res.status}).` };
    else value = { status: "ok", insights: (await res.json()) as Insights };
  } catch (e) {
    value = { status: "error", reason: opts.signal?.aborted ? "Timed out." : e instanceof Error ? e.message : "Solar lookup failed." };
  }
  if (value.status !== "error") {
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value as string);
    cache.set(k, { at: Date.now(), value });
  }
  return value;
}

export async function lookupPanels(q: { lat: number; lng: number; kwp: number }, opts: PanelsOptions = {}): Promise<PanelsResult> {
  const key = opts.key ?? process.env.GOOGLE_MAPS_API_KEY ?? "";
  if (!key) return { status: "no_key", reason: "GOOGLE_MAPS_API_KEY is not set." };
  const got = await insightsAt(q.lat, q.lng, key, opts);
  if (got.status !== "ok") return got;
  return { status: "ok", imagery_quality: got.insights.imageryQuality ?? "UNKNOWN", ...placePanels(got.insights, q.kwp) };
}

const num = (v: string | null) => (v == null || v.trim() === "" ? NaN : Number(v));

/** GET /api/solar/panels?lat=&lng=&kwp=  (or ?address=&kwp=) → 200 PanelsResult; 400 bad input; 429. */
export async function handlePanelsRequest(req: Request, opts: PanelsOptions = {}): Promise<Response> {
  const q = new URL(req.url).searchParams;
  const kwp = num(q.get("kwp"));
  const address = q.get("address")?.trim();
  let lat = num(q.get("lat"));
  let lng = num(q.get("lng"));
  if (!Number.isFinite(kwp) || kwp < 0 || kwp > MAX_KWP) return Response.json({ error: `kwp must be 0..${MAX_KWP}` }, { status: 400 });
  if (!address && !(Math.abs(lat) <= 90 && Math.abs(lng) <= 180))
    return Response.json({ error: "lat and lng (or address) are required" }, { status: 400 });
  if (address && address.length > 300) return Response.json({ error: "address too long" }, { status: 400 });
  if (!allowRequest("solar-panels", clientKey(req), 20, 60_000)) return Response.json({ error: "too many requests" }, { status: 429 });
  if (address && !(Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) {
    const s = await lookupSolar(address, opts);
    if (s.status !== "ok") return Response.json({ status: s.status, reason: s.reason } satisfies PanelsResult);
    lat = s.lat;
    lng = s.lng;
  }
  return Response.json(await lookupPanels({ lat, lng, kwp }, opts));
}
