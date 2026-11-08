import type { SolarResult } from "../../lib/solar";
import type { RoofInput } from "./types";

const offSouth = (az: number) => Math.abs(((((az - 180) % 360) + 540) % 360) - 180);

/**
 * Turn a GET /api/solar result into House3D's `roof` prop: the face an installer would use (among faces with at least
 * 70 % of the largest area, the one closest to south; same rule as lib/solar roofFromSolar), the panel cap and the
 * location for the sun's path. Returns undefined when Google Solar has nothing, so the defaults apply.
 */
export function roofFromSolarResult(s: SolarResult | null | undefined): RoofInput | undefined {
  if (!s || s.status !== "ok") return undefined;
  const faces = s.segments.filter((x) => [x.pitch_deg, x.azimuth_deg, x.area_m2].every(Number.isFinite));
  const place = { latitude: s.lat, longitude: s.lng };
  if (!faces.length) return { ...place, maxPanels: s.max_panels || undefined };
  const maxArea = Math.max(...faces.map((x) => x.area_m2));
  const best = faces
    .filter((x) => x.area_m2 >= 0.7 * maxArea)
    .reduce((a, b) => (offSouth(b.azimuth_deg) < offSouth(a.azimuth_deg) ? b : a));
  return {
    ...place,
    pitchDeg: Math.round(best.pitch_deg),
    azimuthDeg: Math.round(best.azimuth_deg) % 360,
    maxPanels: s.max_panels > 0 ? s.max_panels : undefined,
  };
}
