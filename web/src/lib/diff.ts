import { fmtValue, UNIT } from "./format";
import type { ComponentKey, Design } from "./types";

export const COMPONENTS: ComponentKey[] = ["pv", "battery", "wallbox", "heatpump"];
const NAME: Record<ComponentKey, string> = { pv: "PV", battery: "Battery", wallbox: "Wallbox", heatpump: "Heat pump" };

/** The size a component shows: null when not included. */
export function sizeOf(d: Design, c: ComponentKey): number | null {
  const x = d[c];
  if (!x.include) return null;
  return (c === "pv" ? d.pv.kwp : c === "battery" ? d.battery.kwh : c === "wallbox" ? d.wallbox.kw : d.heatpump.kw) ?? 0;
}

export interface DesignDiff {
  changed: ComponentKey[];
  lines: string[]; // "PV 9.9 → 10.8 kWp", "wallbox added (11 kW)"
}

/** What changed between two designs, at display precision. */
export function diffDesigns(prev: Design | null | undefined, next: Design): DesignDiff {
  const out: DesignDiff = { changed: [], lines: [] };
  if (!prev) return out;
  for (const c of COMPONENTS) {
    const a = sizeOf(prev, c);
    const b = sizeOf(next, c);
    const sa = a == null ? null : fmtValue(c, a);
    const sb = b == null ? null : fmtValue(c, b);
    if (sa === sb) continue;
    out.changed.push(c);
    const lower = NAME[c].toLowerCase();
    if (sa == null) out.lines.push(`${lower} added${b ? ` (${sb} ${UNIT[c]})` : ""}`);
    else if (sb == null) out.lines.push(`${lower} removed`);
    else out.lines.push(`${NAME[c]} ${sa} → ${sb} ${UNIT[c]}`);
  }
  return out;
}
