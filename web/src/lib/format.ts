import type { ComponentKey } from "./types";

const int = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const kwp = new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 2 });
const upTo1 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

export const fmtInt = (n: number) => int.format(Math.round(n));
/** kWp with the precision packages need (0.45 kWp panels: 11.25, 8.55), never fewer than one decimal. */
export const fmtKwp = (n: number) => kwp.format(n);
export const fmtPct = (share: number) => int.format(Math.round(share * 100));
export const fmtEur = (n: number) => `€${int.format(Math.round(n))}`;
export const fmtNum = (n: number) => upTo1.format(n);

export const UNIT: Record<ComponentKey, string> = { pv: "kWp", battery: "kWh", wallbox: "kW", heatpump: "kW" };
export const LABEL: Record<ComponentKey, string> = { pv: "Solar", battery: "Battery", wallbox: "Wallbox", heatpump: "Heat pump" };
/** Homeowner words: no jargon. */
export const PLAIN_LABEL: Record<ComponentKey, string> = { pv: "Solar panels", battery: "Battery", wallbox: "Car charger", heatpump: "Heat pump" };

/** Size number as displayed (no unit). */
export function fmtValue(c: ComponentKey, v: number) {
  return c === "pv" ? fmtKwp(v) : fmtNum(v);
}
export function fmtSize(c: ComponentKey, v: number | null | undefined) {
  return v == null || v === 0 ? "None" : `${fmtValue(c, v)} ${UNIT[c]}`;
}

export function fmtRelative(iso: string, now = Date.now()) {
  const s = (now - new Date(iso).getTime()) / 1000;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400 && new Date(iso).getDate() === new Date(now).getDate()) return `${Math.floor(s / 3600)} h`;
  if (s < 2 * 86400) return "Yesterday";
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}
