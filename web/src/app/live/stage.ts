import type { DesignResponse } from "@/lib/types";
import type { Facts } from "./facts";

/**
 * What the /live house shows so far. Each spoken fact turns on one step:
 * call starts → shell · yearly use → warm windows · first draft → panels (+ inverter) · engine battery → modules ·
 * engine wallbox (the EV answer re-drafts) → car drives in · gas/oil heating → heat pump option ghost.
 * Existing solar needs no step: the home's existing_pv_kwp puts those panels on the roof.
 */
export interface LiveReveal {
  shell: boolean;
  warm: boolean;
  panels: boolean;
  battery: boolean;
  car: boolean;
  heatpump: boolean;
}

/** Build order: one step lands at a time, so the house assembles instead of popping. */
export const REVEAL_ORDER: readonly (keyof LiveReveal)[] = ["shell", "warm", "panels", "battery", "car", "heatpump"];

const FOSSIL = /\b(gas|oil|erdgas|heizöl|öl)\b|^(gas|oil)/i;

export function revealFromFacts(f: Facts, draft: DesignResponse | null, active: boolean): LiveReveal {
  const d = draft?.design;
  const pv = !!d && d.pv.include && (d.pv.kwp ?? 0) > 0;
  const battery = !!d && d.battery.include && (d.battery.kwh ?? 0) > 0;
  const wallbox = !!d && d.wallbox.include;
  const heating = (f.heating ?? "").replace(/_/g, " ");
  return {
    shell: active,
    warm: active && (f.annual_kwh != null || f.monthly_bill_eur != null || f.annual_kwh_estimate != null),
    panels: active && pv,
    battery: active && battery,
    car: active && wallbox,
    heatpump: active && ((!!d && d.heatpump.include) || FOSSIL.test(heating)),
  };
}

/** Advance `cur` toward `target`: the next missing step in build order; anything to remove goes at once. */
export function stepToward(cur: LiveReveal, target: LiveReveal): LiveReveal {
  const removals = REVEAL_ORDER.filter((k) => cur[k] && !target[k]);
  if (removals.length) {
    const next = { ...cur };
    for (const k of removals) next[k] = false;
    return next;
  }
  const add = REVEAL_ORDER.find((k) => target[k] && !cur[k]);
  return add ? { ...cur, [add]: true } : cur;
}

const off = { include: false, confidence: 0, reasons: [] as string[] };

/** A house with nothing on it yet (before the first draft). Not an engine design; nothing reads sizes from it. */
export const EMPTY_DESIGN: DesignResponse = {
  design: {
    pv: { ...off, kwp: null, range: [0, 0] },
    battery: { ...off, kwh: null, range: [0, 0] },
    wallbox: { ...off, kw: null },
    heatpump: { ...off, kw: null },
  },
  physics: { yield_kwh: 0, self_consumption: 0, autarky: 0, warnings: [] },
  similar_homes: [],
  facts_for_explanation: {},
  model_version: "live-empty",
};

/**
 * The engine's draft with the not-yet-revealed parts switched off (include=false). Sizes are never changed,
 * so once every step is revealed this is the engine's design exactly.
 */
export function stagedDesign(draft: DesignResponse | null, r: LiveReveal): DesignResponse {
  if (!draft) return EMPTY_DESIGN;
  const d = draft.design;
  return {
    ...draft,
    design: {
      pv: r.panels ? d.pv : { ...d.pv, include: false },
      battery: r.battery ? d.battery : { ...d.battery, include: false },
      wallbox: r.car ? d.wallbox : { ...d.wallbox, include: false },
      heatpump: r.heatpump ? d.heatpump : { ...d.heatpump, include: false },
    },
  };
}
