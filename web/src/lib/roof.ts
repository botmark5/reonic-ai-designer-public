import { roofFromSolarResult } from "@/components/house3d/solarRoof";
import type { SolarResult } from "./solar";
import type { Home } from "./types";

export type RoofInputs = Pick<Home, "roof_max_kwp" | "roof_azimuth" | "roof_pitch">;

/**
 * Engine roof inputs (engine #27) from a GET /api/solar result: the most PV the roof fits (Google's max panel count ×
 * panel watts), and the direction and pitch of the face an installer would use. null when Google has nothing, so the
 * fields are omitted and the engine designs as before.
 */
export function roofInputsFromSolar(s: SolarResult | null | undefined): RoofInputs | null {
  if (!s || s.status !== "ok") return null;
  const face = roofFromSolarResult(s);
  const kwp = s.max_panels > 0 && s.panel_watts > 0 ? Math.min(200, Math.round(s.max_panels * s.panel_watts) / 1000) : null;
  const out: RoofInputs = { roof_max_kwp: kwp, roof_azimuth: face?.azimuthDeg ?? null, roof_pitch: face?.pitchDeg ?? null };
  return out.roof_max_kwp == null && out.roof_azimuth == null && out.roof_pitch == null ? null : out;
}

/** True until roof inputs were filled once (by Google Solar or the planner). An explicit null means the planner removed them. */
export function roofNotAsked(home: Home): boolean {
  return home.roof_max_kwp === undefined && home.roof_azimuth === undefined && home.roof_pitch === undefined;
}

const DIRS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
/** 180 → "south", 225 → "south-west". */
export function compass(deg: number | null | undefined): string | null {
  if (deg == null || !Number.isFinite(deg)) return null;
  return DIRS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}
