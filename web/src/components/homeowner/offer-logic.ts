import type { DesignResponse } from "@/lib/types";

/** The house's modelled day runs 6–22 h. */
export const DAY_START = 6;
export const DAY_END = 22;
/** Without timed sentences, Listen walks the house from morning to evening over the clip. */
const FALLBACK_FROM = 7;
const FALLBACK_TO = 20;
/** Seconds the sun takes to move to a new sentence's hour (eased, no jumps). */
const TRANSITION_S = 1.6;

/** One sentence of the spoken offer (d-voice: lib/voice.ts TimedSegment). */
export interface TimedSegment {
  text: string;
  moment: "morning" | "noon" | "evening" | null;
  start_s: number;
  end_s: number;
  /** Clock time the house should show while this sentence plays; null = keep the current time. */
  time_of_day_h: number | null;
}

const clampHour = (h: number) => Math.min(DAY_END, Math.max(DAY_START, h));
const smooth = (x: number) => x * x * (3 - 2 * x); // ease in-out, starts and lands with zero speed

/**
 * Audio time (s) → the hour the house shows. Each timed sentence moves the sun to its hour over the first
 * ~1.6 s of the sentence, then holds; untimed sentences keep the last hour. No timed sentences: 7 → 20 h linearly.
 */
export function timeOfDayAt(t: number, segments: TimedSegment[], duration_s: number): number {
  const keys = segments
    .filter((s) => s.time_of_day_h != null && Number.isFinite(s.time_of_day_h) && Number.isFinite(s.start_s))
    .sort((a, b) => a.start_s - b.start_s)
    .map((s) => ({ at: s.start_s, h: clampHour(s.time_of_day_h!), span: Math.max(0.2, Math.min(TRANSITION_S, (s.end_s ?? s.start_s) - s.start_s)) }));
  const time = Number.isFinite(t) ? Math.max(0, t) : 0;
  if (!keys.length) {
    const p = duration_s > 0 ? Math.min(1, time / duration_s) : 0;
    return FALLBACK_FROM + (FALLBACK_TO - FALLBACK_FROM) * p;
  }
  let h = keys[0].h;
  for (let i = 1; i < keys.length; i++) {
    const k = keys[i];
    if (time <= k.at) break;
    const p = Math.min(1, (time - k.at) / k.span);
    h = p >= 1 ? k.h : h + (k.h - h) * smooth(p);
    if (p < 1) break;
  }
  return h;
}

export interface VariantNumbers {
  pv: number | null;
  battery: number | null;
  yieldKwh: number | null;
  autarky: number;
  savings: number | null;
  heatingSavings: number;
  payback: number | null;
  capex: number | null;
}

/**
 * The design the homeowner is looking at, with or without the heat pump. "With" uses the engine's own
 * with_heatpump variant (PV and battery may grow with the heat pump's load); sizes are never computed here.
 */
export function variantView(d: DesignResponse, heatpumpOn: boolean): { design: DesignResponse; heatpump: number | null; numbers: VariantNumbers } {
  const hp = d.options?.heatpump;
  const base: VariantNumbers = {
    pv: d.design.pv.include ? d.design.pv.kwp : null,
    battery: d.design.battery.include ? d.design.battery.kwh : null,
    yieldKwh: d.physics.yield_kwh || null,
    autarky: d.physics.autarky,
    savings: d.economics?.savings_first_year_eur ?? null,
    heatingSavings: 0,
    payback: d.economics?.payback_years ?? null,
    capex: d.economics?.capex_total_eur ?? null,
  };
  if (!heatpumpOn || !hp || !hp.available || d.design.heatpump.include) {
    return { design: d, heatpump: d.design.heatpump.include ? d.design.heatpump.kw : null, numbers: base };
  }
  const w = hp.with_heatpump;
  const basePv = d.design.pv.include ? d.design.pv.kwp : null;
  const yieldKwh = base.yieldKwh != null && basePv && w.pv_kwp ? base.yieldKwh * (w.pv_kwp / basePv) : base.yieldKwh;
  const design: DesignResponse = {
    ...d,
    design: {
      ...d.design,
      pv: w.pv_kwp ? { ...d.design.pv, include: true, kwp: w.pv_kwp } : d.design.pv,
      battery: w.battery_kwh ? { ...d.design.battery, include: true, kwh: w.battery_kwh } : { ...d.design.battery, include: false, kwh: null },
      heatpump: { ...d.design.heatpump, include: true, kw: hp.kw, reasons: hp.reasons },
    },
  };
  return {
    design,
    heatpump: hp.kw,
    numbers: {
      pv: w.pv_kwp, battery: w.battery_kwh, yieldKwh, autarky: w.autarky, savings: w.savings_first_year_eur,
      heatingSavings: w.heating_savings_eur, payback: w.payback_years, capex: w.capex_total_eur,
    },
  };
}

/** The sentence to show at audio time t: the last one that has started, so the caption holds through short gaps. */
export function captionAt(t: number, segments: TimedSegment[]): TimedSegment | null {
  let cur: TimedSegment | null = null;
  for (const s of segments) if (Number.isFinite(s.start_s) && s.start_s <= t && (!cur || s.start_s >= cur.start_s)) cur = s;
  return cur;
}

/** Plain words for the homeowner: no markdown (bold, headings, bullets) and no [voice tags]. */
export function plainText(s: string): string {
  return s
    .replace(/\[[^\]]*\]/g, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/^\s{0,3}(#{1,6}|[-*•])\s+/gm, "")
    .replace(/[*_]{2,}/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export type OfferPart = "pv" | "battery" | "wallbox" | "heatpump";
const PART_NAME: Record<OfferPart, string> = { pv: "Solar panels", battery: "Battery", wallbox: "Car charger", heatpump: "Heat pump" };
const PART_WHAT: Record<OfferPart, string> = {
  pv: "Makes electricity from the sun on your roof.",
  battery: "Stores the midday sun for the evening.",
  wallbox: "Charges your car from your own solar.",
  heatpump: "Heats your home with electricity instead of gas or oil.",
};
const PART_UNIT: Record<OfferPart, string> = { pv: "kWp", battery: "kWh", wallbox: "kW", heatpump: "kW" };
const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} or ${xs.at(-1)}`);

/**
 * The plain-words line under the house when the homeowner clicks a part: what it is, its size (from the engine's
 * design), and whether they can change it (only the installer's allowed values) or the installer set it.
 */
export function partLine(part: OfferPart, size: number | null, choices: (number | boolean)[]): string {
  const sized = size ? `${PART_NAME[part]} · ${size} ${PART_UNIT[part]}` : `${PART_NAME[part]} · not included`;
  const opts = choices.filter((v) => typeof v === "number") as number[];
  const can =
    part === "wallbox"
      ? choices.length > 1
        ? "You can choose with or without it below."
        : "Set by your installer."
      : part === "heatpump"
        ? choices.length > 1
          ? "An option: you can add it below."
          : "Set by your installer."
        : opts.length > 1
          ? `You can choose ${list(opts.map((v) => (v === 0 ? "none" : `${v} ${PART_UNIT[part]}`)))} below.`
          : "Set by your installer.";
  return `${sized}. ${PART_WHAT[part]} ${can}`;
}
