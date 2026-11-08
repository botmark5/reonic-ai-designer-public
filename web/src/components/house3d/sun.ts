/**
 * Where the sun is. NOAA's low-precision solar position equations (accurate to well under a degree), plus the
 * light the scene uses for it. World axes: +x east, +y up, +z south.
 */
import * as THREE from "three";

export interface SunPos {
  elevationDeg: number;
  /** Compass azimuth, clockwise from north: 90 east, 180 south, 270 west. */
  azimuthDeg: number;
}

export interface Place {
  lat: number;
  lon: number;
  dayOfYear: number;
  /** Hours ahead of UTC for the clock shown (CEST = 2). */
  utcOffset: number;
}

/** A clear mid-May day in Munich, clock in CEST: sunrise ≈ 05:30, sunset ≈ 20:50. */
export const MAY_DAY: Place = { lat: 48.14, lon: 11.58, dayOfYear: 135, utcOffset: 2 };

const D = Math.PI / 180;

export function sunPosition(hourLocal: number, place: Place): SunPos {
  const g = ((2 * Math.PI) / 365) * (place.dayOfYear - 1 + (hourLocal - 12) / 24);
  const eqTime =
    229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl =
    0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) -
    0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const trueSolarMin = hourLocal * 60 + eqTime + 4 * place.lon - 60 * place.utcOffset;
  const ha = (trueSolarMin / 4 - 180) * D;
  const lat = place.lat * D;
  const cosZ = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(ha);
  const zenith = Math.acos(Math.min(1, Math.max(-1, cosZ)));
  const az = Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(lat) - Math.tan(decl) * Math.cos(lat)) / D + 180;
  return { elevationDeg: 90 - zenith / D, azimuthDeg: ((az % 360) + 360) % 360 };
}

/** Unit vector from the scene towards the sun. */
export function sunDirection(p: SunPos, out = new THREE.Vector3()): THREE.Vector3 {
  const el = p.elevationDeg * D;
  const az = p.azimuthDeg * D;
  return out.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const LOW = new THREE.Color("#ffb877"); // golden hour
const MID = new THREE.Color("#ffe3c2");
const HIGH = new THREE.Color("#fffaf4"); // near-neutral midday

/** Key-light colour and intensity for a sun elevation. Warm and soft when low, neutral at midday, off at night. */
export function sunLight(elevationDeg: number): { color: THREE.Color; intensity: number } {
  const color = LOW.clone().lerp(MID, smooth(0, 14, elevationDeg)).lerp(HIGH, smooth(14, 45, elevationDeg));
  const intensity = elevationDeg <= -2 ? 0 : 2.6 * smooth(-2, 10, elevationDeg) * (0.75 + 0.25 * smooth(10, 50, elevationDeg));
  return { color, intensity };
}
