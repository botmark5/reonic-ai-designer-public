import { sizeOf } from "@/lib/diff";
import type { ComponentKey, DesignResponse } from "@/lib/types";
import { ALLOWED, DEFAULTS, ZONE_ORDER, ZONES, WHY_NOT, type InsideKey, type Zone } from "@/components/house3d/insideRules";

/** The part that stands inside / on the wall for a picked component (solar → its inverter). */
export function insideKeyOf(c: ComponentKey): InsideKey {
  return c === "pv" ? "inverter" : c;
}

/**
 * The lock for "Want it? Yes / No". Sizes only ever come from the engine's own answer: the current size, the heat pump
 * option, or the smallest size the engine itself offered (alternatives / range). null = no engine size to say yes with
 * (the planner picks one in the size editor instead). Solar has no yes/no (it is the system).
 */
export function wantLock(c: ComponentKey, r: DesignResponse, yes: boolean, prev?: DesignResponse | null): number | boolean | null {
  const d = r.design;
  if (c === "pv") return null;
  if (c === "wallbox") return yes;
  if (!yes) return 0;
  const now = sizeOf(d, c);
  if (now) return now;
  // No, then Yes again: back to the size the engine had chosen before
  const was = prev ? sizeOf(prev.design, c) : null;
  if (was) return was;
  if (c === "heatpump") return r.options?.heatpump?.available ? r.options.heatpump.kw : null;
  const offered = [...(d.battery.alternatives ?? []).map((a) => a.kwh), ...(d.battery.range ?? [])].filter((x) => x > 0);
  return offered.length ? Math.min(...offered) : null;
}

export function wants(c: ComponentKey, r: DesignResponse): boolean {
  return !!r.design[c].include;
}

export interface ZoneChoice {
  zone: Zone;
  label: string;
  allowed: boolean;
  why: string;
}
export function zoneChoices(c: ComponentKey): ZoneChoice[] {
  const k = insideKeyOf(c);
  return ZONE_ORDER.map((z) => ({ zone: z, label: ZONES[z].label, allowed: ALLOWED[k].includes(z), why: ALLOWED[k].includes(z) ? "" : WHY_NOT[k] }));
}
export function zoneOf(c: ComponentKey, zones: Partial<Record<InsideKey, Zone>>): Zone {
  const k = insideKeyOf(c);
  return zones[k] ?? DEFAULTS[k];
}

export interface CompareRow {
  label: string;
  before: number | null;
  after: number | null;
  unit: string;
  /** 1 = more is better, 0 = neutral */
  better: 1 | 0;
}
const UNIT: Record<ComponentKey, string> = { pv: "kWp", battery: "kWh", wallbox: "kW", heatpump: "kW" };
const NAME: Record<ComponentKey, string> = { pv: "Solar", battery: "Battery", wallbox: "Wallbox", heatpump: "Heat pump" };

/** Before → after for the picked part: its size, then yield, self-sufficiency and first-year savings (engine numbers only). */
export function compareRows(c: ComponentKey, before: DesignResponse, after: DesignResponse): CompareRow[] {
  const pct = (x: number | undefined) => (x == null ? null : Math.round(x * 100));
  return [
    { label: NAME[c], before: sizeOf(before.design, c), after: sizeOf(after.design, c), unit: UNIT[c], better: 0 },
    { label: "Solar yield", before: before.physics.yield_kwh || null, after: after.physics.yield_kwh || null, unit: "kWh / yr", better: 1 },
    { label: "Self-sufficiency", before: pct(before.physics.autarky), after: pct(after.physics.autarky), unit: "%", better: 1 },
    { label: "Savings, year one", before: before.economics?.savings_first_year_eur ?? null, after: after.economics?.savings_first_year_eur ?? null, unit: "€", better: 1 },
  ];
}
