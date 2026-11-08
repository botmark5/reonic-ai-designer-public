/**
 * What the homeowner may change on the offer page. The installer decides it when sending (planner "Send to homeowner"),
 * it is stored with the share (shares.allowed_variants) and the server rejects every choice outside it.
 * Values only ever come from the engine's own design and alternatives: the installer can narrow them, never add sizes.
 */
import type { DesignResponse } from "./types";

export type AllowedComponent = "pv" | "battery" | "wallbox" | "heatpump";

export interface AllowedVariant {
  component: AllowedComponent;
  values: (number | boolean)[];
}

export interface OfferChoice {
  pv_kwp?: number;
  battery_kwh?: number;
  wallbox?: boolean;
  heatpump?: boolean;
}

const COMPONENTS: AllowedComponent[] = ["pv", "battery", "wallbox", "heatpump"];
const same = (a: number | boolean, b: number | boolean) =>
  typeof a === "number" && typeof b === "number" ? Math.abs(a - b) < 0.01 : a === b;
const uniq = (xs: (number | boolean)[]) => xs.filter((x, i) => xs.findIndex((y) => same(x, y)) === i);
const sortVals = (xs: (number | boolean)[]) => [...xs].sort((a, b) => Number(a) - Number(b));

/** The design's own value per component (what the homeowner starts from). */
export function currentValues(d: DesignResponse): Record<AllowedComponent, number | boolean> {
  const g = d.design;
  return {
    pv: g.pv.include ? (g.pv.kwp ?? 0) : 0,
    battery: g.battery.include ? (g.battery.kwh ?? 0) : 0,
    wallbox: g.wallbox.include,
    heatpump: g.heatpump.include,
  };
}

/** Everything the installer could let the homeowner choose: the engine's alternatives, none / with, on / off. */
export function defaultAllowed(d: DesignResponse): AllowedVariant[] {
  const cur = currentValues(d);
  const pv = uniq([cur.pv, ...(d.design.pv.alternatives ?? []).map((a) => a.kwp)]).filter((v) => (v as number) > 0 || v === cur.pv);
  const battery = uniq([0, cur.battery, ...(d.design.battery.alternatives ?? []).map((a) => a.kwh)]);
  const hpOption = !d.design.heatpump.include && Boolean(d.options?.heatpump?.available);
  return [
    { component: "pv", values: sortVals(pv) },
    { component: "battery", values: sortVals(battery) },
    { component: "wallbox", values: [true, false] },
    { component: "heatpump", values: hpOption ? [false, true] : [cur.heatpump] },
  ];
}

/**
 * The installer's selection, made safe against the CURRENT design: per component only values the engine offers
 * (defaultAllowed), always including the design's own value. A component the installer left out is fixed at that value.
 * Shares stored before pv / heat pump existed (only battery + wallbox) keep their old meaning: heat pump option allowed.
 */
export function restrictAllowed(requested: unknown, d: DesignResponse): AllowedVariant[] {
  const all = defaultAllowed(d);
  const cur = currentValues(d);
  const list = Array.isArray(requested) ? (requested as Partial<AllowedVariant>[]) : [];
  const legacy = list.length > 0 && !list.some((a) => a?.component === "pv" || a?.component === "heatpump");
  return COMPONENTS.map((c) => {
    const offered = all.find((a) => a.component === c)!.values;
    const asked = list.find((a) => a?.component === c);
    const wanted = legacy && c === "heatpump" ? offered : Array.isArray(asked?.values) ? asked.values : [];
    const values = offered.filter((v) => same(v, cur[c]) || wanted.some((w) => (typeof w === "number" || typeof w === "boolean") && same(v, w)));
    return { component: c, values: values.length ? values : [cur[c]] };
  });
}

/** True if every chosen value is one the installer allowed. */
export function choiceAllowed(allowed: AllowedVariant[], choice: OfferChoice): boolean {
  const ok = (c: AllowedComponent, v: number | boolean | undefined) => {
    if (v === undefined) return true;
    const a = allowed.find((x) => x.component === c);
    return !!a && a.values.some((x) => same(x, v));
  };
  return ok("pv", choice.pv_kwp) && ok("battery", choice.battery_kwh) && ok("wallbox", choice.wallbox) && ok("heatpump", choice.heatpump);
}

/** Values the homeowner may pick for one component ([] when the component is fixed). */
export const choicesFor = (allowed: AllowedVariant[], c: AllowedComponent) => {
  const v = allowed.find((a) => a.component === c)?.values ?? [];
  return v.length > 1 ? v : [];
};
