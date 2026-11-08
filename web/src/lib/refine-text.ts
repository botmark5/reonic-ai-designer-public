/**
 * Plain-language refine feedback: which home facts changed and what that did to the design. Shared by the agent
 * (Claude path and engine /refine fallback). Never "nothing changed" after an input really changed.
 */
import type { Home } from "./types";

const int = (n: number) => Math.round(n).toLocaleString("en-US");
const yesNo = (v: unknown) => (v ? "yes" : "no");

const FIELD: Partial<Record<keyof Home, (v: unknown) => string>> = {
  annual_kwh: (v) => `yearly use ${int(v as number)} kWh`,
  price_eur_kwh: (v) => `price ${(v as number).toFixed(2)} €/kWh`,
  inhabitants: (v) => `${v} people`,
  has_ev: (v) => `electric car: ${yesNo(v)}`,
  ev_km_year: (v) => `car ${int(v as number)} km a year`,
  heating: (v) => `heating: ${String(v).toLowerCase()}`,
  heating_demand_kwh: (v) => `heating demand ${int(v as number)} kWh`,
  roof_type: (v) => `roof: ${String(v).toLowerCase()}`,
  has_existing_pv: (v) => `solar already on the roof: ${yesNo(v)}`,
  existing_pv_kwp: (v) => `existing solar ${v} kWp`,
  existing_battery_kwh: (v) => `existing battery ${v} kWh`,
};

/** Facts that differ between two homes, in plain words ("car 30,000 km a year"). */
export function inputChanges(before: Partial<Home>, after: Partial<Home>): string[] {
  const out: string[] = [];
  for (const k of Object.keys(FIELD) as (keyof Home)[]) {
    const a = before[k];
    const b = after[k];
    if (a === b || b === undefined || (a == null && b == null)) continue;
    out.push(b === null ? `${String(k).replace(/_/g, " ")} cleared` : FIELD[k]!(b));
  }
  return out;
}

/** Same facts, from a tool call's changes ("Inputs: electric car: yes, car 30,000 km a year"). */
export function changesLabel(changes: Record<string, unknown>): string {
  const parts = Object.entries(changes).map(([k, v]) => {
    const f = FIELD[k as keyof Home];
    return v === null ? `${k.replace(/_/g, " ")} cleared` : f ? f(v) : `${k.replace(/_/g, " ")}: ${v}`;
  });
  return `Updating ${parts.join(", ") || "nothing"}`;
}

const NO_CHANGE = /\b(nothing (has )?changed|no changes?\b|unchanged)/i;

/**
 * The line the refine box shows. Claude's own sentence wins unless it claims nothing changed although inputs did;
 * then (and when there is no sentence) it is built from the facts.
 */
export function refineSummary(opts: { text?: string | null; inputs: string[]; designLines: string[] }): string {
  const text = opts.text?.trim() ?? "";
  if (text && !(opts.inputs.length && NO_CHANGE.test(text))) return text;
  const inputs = opts.inputs.length ? `Updated ${opts.inputs.join(", ")}.` : "";
  const design = opts.designLines.length ? ` New design: ${opts.designLines.join(", ")}.` : opts.inputs.length ? " The sizes stay the same." : "";
  return (inputs + design).trim() || "Nothing in this note changes the home or the design.";
}
