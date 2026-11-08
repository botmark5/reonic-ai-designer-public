/**
 * Offline estimate: a deterministic MOCK of the engine (docs/api.md). Pure functions, no I/O, safe anywhere.
 * Used by lib/engine.ts when ENGINE_URL is unset or the engine does not answer in time.
 * It is NOT the model: rules of thumb only. Output has model_version "MOCK" and reasons prefixed "[mock]".
 */
import type {
  DesignRequest,
  DesignResponse,
  EvalResponse,
  ExplainRequest,
  Home,
  Locks,
  ProjectResponse,
  RefineRequest,
  RefineResponse,
  SimilarHome,
  ValidateRequest,
  ValidateResponse,
  ValidationFlag,
} from "./types";
import { EMPTY_LOCKS } from "./types";

export const DEFAULT_INSTALLER = "installer_a";

// ---------------------------------------------------------------------------
// MOCK (deterministic rules of thumb; not the model)
// ---------------------------------------------------------------------------
export const MOCK_MODULE_KWP = 0.45;
export const MOCK_BATTERY_SIZES = [5, 7, 10, 14] as const;
const MOCK_VERSION = "MOCK";
const SPECIFIC_YIELD = 950; // kWh per kWp and year, southern Germany

const round1 = (x: number) => Math.round(x * 10) / 10;
const round2 = (x: number) => Math.round(x * 100) / 100;

/** Snap to whole 450 W modules, at least 4 modules. */
export function snapPv(kwp: number): number {
  return round2(Math.max(4, Math.round(kwp / MOCK_MODULE_KWP)) * MOCK_MODULE_KWP);
}

export function snapBattery(kwh: number): number {
  return MOCK_BATTERY_SIZES.reduce((best, s) => (Math.abs(s - kwh) < Math.abs(best - kwh) ? s : best));
}

/** EV consumption: km/100 × 18 kWh (same rule as engine/physics.py). */
export function evKwh(home: Home): number {
  if (!home.has_ev) return 0;
  return ((home.ev_km_year ?? 12000) / 100) * 18;
}

/** Small stable hash for deterministic "similar homes". */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function seeded(seed: number) {
  let a = seed || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function mockDesign(req: DesignRequest): DesignResponse {
  const { home } = req;
  const locks: Locks = { ...EMPTY_LOCKS, ...req.locks };
  const ev = evKwh(home);
  const household = Math.max(0, home.annual_kwh);
  const fmt = (n: number) => Math.round(n).toLocaleString("en-US");

  // PV: annual kWh / 1000 + EV bonus, snapped to 450 W modules
  const pvRaw = household / 1000 + ev / 1000;
  const roofCap = home.roof_max_kwp && home.roof_max_kwp > 0 ? Math.floor(home.roof_max_kwp / 0.45) * 0.45 : Infinity;
  const pvAuto = household > 0 ? Math.min(snapPv(pvRaw), Math.round(roofCap * 100) / 100) : 0;
  const pvKwp = locks.pv_kwp ?? pvAuto;
  const hasPv = pvKwp > 0;
  const pvRange: [number, number] = [snapPv(pvAuto * 0.85), snapPv(pvAuto * 1.2)];

  // Battery: ≈ PV size, snapped to 5/7/10/14 kWh; none without PV
  const batAuto = hasPv ? snapBattery(pvKwp) : 0;
  const batKwh = locks.battery_kwh ?? batAuto;
  const hasBat = batKwh > 0;

  // Wallbox: if the household has an EV
  const hasWb = locks.wallbox ?? home.has_ev;
  // Heat pump: the mock never proposes one (engine decides this as a customer option)
  const hpKw = locks.heatpump_kw ?? 0;

  // Physics (rough)
  const load = household + ev + (hpKw > 0 ? (home.heating_demand_kwh ?? 18000) / 3.5 : 0);
  const yieldKwh = hasPv ? Math.round(pvKwp * SPECIFIC_YIELD) : 0;
  const ratio = load > 0 ? yieldKwh / load : 0;
  const scBase = hasPv ? Math.min(0.9, 0.3 / Math.max(ratio, 0.3) + 0.05) : 0;
  const scBat = hasBat ? Math.min(0.35, (batKwh / Math.max(pvKwp, 1)) * 0.25) : 0;
  const selfConsumption = round2(Math.min(0.95, scBase + scBat));
  const autarky = load > 0 ? round2(Math.min(0.85, (yieldKwh * selfConsumption) / load)) : 0;
  const warnings: string[] = [];
  if (hasBat && !hasPv) warnings.push("Battery planned without PV.");
  if (hasPv && ratio > 2.5) warnings.push(`${pvKwp} kWp produces ${ratio.toFixed(1)}× the yearly demand.`);

  const price = home.price_eur_kwh ?? 0.32;
  const capex = Math.round(pvKwp * 1400 + batKwh * 650 + (hasWb ? 1500 : 0) + hpKw * 2000);
  const selfUsed = yieldKwh * selfConsumption;
  const savings = Math.round(selfUsed * price + (yieldKwh - selfUsed) * 0.08);

  // Similar homes, deterministic per input
  const rnd = seeded(hash(`${req.installer}|${Math.round(household / 250)}|${home.has_ev}`));
  const similar: SimilarHome[] = Array.from({ length: 5 }, (_, i) => {
    const kwh = Math.round((household * (0.88 + rnd() * 0.24)) / 50) * 50;
    const pv = snapPv(kwh / 1000 + (home.has_ev ? 2 : 0) + (rnd() - 0.5) * 2);
    return {
      project_id: `mock-${(hash(`${req.installer}-${i}-${kwh}`) % 0xffffff).toString(16).padStart(6, "0")}`,
      annual_kwh: kwh,
      pv_kwp: pv,
      battery_kwh: rnd() > 0.2 ? snapBattery(pv) : null,
      similarity: round2(0.95 - i * 0.04 - rnd() * 0.02),
    };
  });

  const m = (s: string) => `[mock] ${s}`;
  return {
    design: {
      pv: {
        include: hasPv,
        kwp: hasPv ? pvKwp : null,
        range: pvRange,
        confidence: locks.pv_kwp != null ? 1 : 0.72,
        reasons: locks.pv_kwp != null
          ? [m(`Locked by the planner at ${pvKwp} kWp.`)]
          : [
              m(`${fmt(household)} kWh household demand → about ${round1(household / 1000)} kWp.`),
              ...(ev > 0 ? [m(`EV adds ${fmt(ev)} kWh a year → +${round1(ev / 1000)} kWp.`)] : []),
              m(`Snapped to ${Math.round(pvKwp / MOCK_MODULE_KWP)} modules of 450 W.`),
            ],
        alternatives: [], // the real engine lists up to two other standard sizes; the estimate has no catalogue
      },
      battery: {
        include: hasBat,
        kwh: hasBat ? batKwh : null,
        range: hasPv ? [snapBattery(pvKwp * 0.7), snapBattery(pvKwp * 1.3)] : [0, 0],
        confidence: locks.battery_kwh != null ? 1 : 0.66,
        reasons: locks.battery_kwh != null
          ? [m(`Locked by the planner at ${batKwh} kWh.`)]
          : hasPv
            ? [m(`About 1 kWh of storage per kWp of PV → ${batKwh} kWh (catalogue: 5/7/10/14 kWh).`)]
            : [m("No PV, so no battery.")],
        alternatives: hasPv
          ? MOCK_BATTERY_SIZES.map((s) => ({ kwh: s, share: s === batKwh ? 0.55 : 0.15 }))
          : [],
      },
      wallbox: {
        include: hasWb,
        kw: hasWb ? 11 : null,
        confidence: locks.wallbox != null ? 1 : home.has_ev ? 0.85 : 0.7,
        reasons: locks.wallbox != null
          ? [m(`Locked by the planner (${hasWb ? "with" : "without"} wallbox).`)]
          : [m(home.has_ev ? "The household has an EV → 11 kW wallbox." : "No EV recorded → no wallbox.")],
      },
      heatpump: {
        include: hpKw > 0,
        kw: hpKw > 0 ? hpKw : null,
        confidence: locks.heatpump_kw != null ? 1 : 0.6,
        reasons: [m(hpKw > 0 ? `Locked by the planner at ${hpKw} kW.` : "The mock never proposes a heat pump.")],
        option: { available: false, kw: null, reasons: [m("Heat pump options come from the live engine.")] },
      },
    },
    physics: {
      yield_kwh: yieldKwh,
      self_consumption: selfConsumption,
      autarky,
      warnings,
      load_kwh: Math.round(load),
      grid_import_kwh: Math.round(load - yieldKwh * selfConsumption),
      feed_in_kwh: Math.round(yieldKwh * (1 - selfConsumption)),
      flags: warnings.map((message) => ({ component: "pv", level: "warn", code: "MOCK_WARNING", message })),
      assumptions: ["[mock] 950 kWh/kWp specific yield, south-facing roof."],
    },
    economics: {
      capex_total_eur: capex,
      savings_first_year_eur: savings,
      payback_years: savings > 0 ? round1(capex / savings) : null,
      savings_lifetime_eur: savings * 20,
      assumptions: ["[mock] Placeholder prices: 1,400 €/kWp, 650 €/kWh, 1,500 € wallbox, 0.08 €/kWh feed-in."],
    },
    options: { heatpump: { available: false, reasons: ["[mock] Heat pump options come from the live engine."] } },
    similar_homes: similar,
    facts_for_explanation: {
      mock: true,
      household_kwh: household,
      ev_kwh: ev,
      pv_kwp: hasPv ? pvKwp : 0,
      battery_kwh: hasBat ? batKwh : 0,
      wallbox: hasWb,
      locks,
      home,
    },
    model_version: MOCK_VERSION,
  };
}

export function mockValidate(req: ValidateRequest): ValidateResponse {
  const ref = mockDesign({ installer: req.installer, home: req.home, locks: EMPTY_LOCKS }).design;
  const flags: ValidationFlag[] = [];
  const check = (component: "pv" | "battery", value: number | null, typical: number | null) => {
    if (!value) {
      flags.push({ component, level: "info", percentile: null, code: `${component.toUpperCase()}_NONE`,
        message: `[mock] No ${component === "pv" ? "PV" : "battery"} planned.` });
      return;
    }
    const r = typical ? value / typical : 1;
    const pct = Math.max(1, Math.min(99, Math.round(50 + (r - 1) * 120)));
    const unusual = pct >= 90 || pct <= 10;
    flags.push({
      component,
      level: unusual ? "warn" : "ok",
      percentile: pct,
      code: `${component.toUpperCase()}_${unusual ? "UNUSUAL" : "TYPICAL"}`,
      message: unusual
        ? `[mock] ${pct >= 90 ? "Larger" : "Smaller"} than ${pct >= 90 ? pct : 100 - pct}% of similar homes`
        : "[mock] Typical for similar homes",
    });
  };
  check("pv", req.design.pv_kwp, ref.pv.kwp);
  check("battery", req.design.battery_kwh, ref.battery.kwh);
  if (req.design.wallbox && !req.home.has_ev)
    flags.push({ component: "wallbox", level: "info", percentile: null, code: "WALLBOX_WITHOUT_EV",
      message: "[mock] Wallbox planned but no electric car recorded." });
  return { flags };
}

/** Keyword parser standing in for the engine's /refine (Claude Haiku there). */
export function mockRefine(req: RefineRequest): RefineResponse {
  const t = req.text.toLowerCase();
  const home: Home = { ...req.home };
  const locks: Locks = { ...EMPTY_LOCKS, ...req.locks };
  const changes: Partial<Home> & Partial<Locks> = {};
  const set = <K extends keyof Home>(k: K, v: Home[K]) => { home[k] = v; (changes as Record<string, unknown>)[k] = v; };
  const lock = <K extends keyof Locks>(k: K, v: Locks[K]) => { locks[k] = v; (changes as Record<string, unknown>)[k] = v; };

  if (/\b(ev|e-auto|electric car|elektroauto)\b/.test(t) && !/\bno (ev|electric car)\b/.test(t)) {
    set("has_ev", true);
    const km = t.match(/(\d[\d.,]*)\s*(k?m|km)\b/);
    set("ev_km_year", km ? Number(km[1].replace(/[.,]/g, "")) : (home.ev_km_year ?? 15000));
  }
  const kwh = t.match(/(\d[\d.,]{2,})\s*kwh/);
  if (kwh && !/battery|speicher/.test(t)) set("annual_kwh", Number(kwh[1].replace(/[.,]/g, "")));
  if (/no battery|without (a )?battery|kein speicher/.test(t)) lock("battery_kwh", 0);
  else {
    const b = t.match(/(\d+(?:[.,]\d+)?)\s*kwh\s*(battery|speicher)/) ?? t.match(/battery[^\d]*(\d+(?:[.,]\d+)?)\s*kwh/);
    if (b) lock("battery_kwh", snapBattery(Number(b[1].replace(",", "."))));
  }
  if (/no wallbox|without (a )?wallbox/.test(t)) lock("wallbox", false);
  else if (/wallbox/.test(t)) lock("wallbox", true);
  if (/no heat ?pump|without (a )?heat ?pump/.test(t)) lock("heatpump_kw", 0);
  else if (/heat ?pump|wärmepumpe/.test(t)) lock("heatpump_kw", 9);

  const design = mockDesign({ installer: req.installer ?? DEFAULT_INSTALLER, home, locks });
  const n = Object.keys(changes).length;
  return {
    changes,
    summary: n ? `[mock] Applied ${n} change${n > 1 ? "s" : ""}: ${Object.keys(changes).join(", ")}.` : "[mock] No change recognised.",
    parsed_by: "mock-keywords",
    home,
    locks,
    design,
  };
}

export function textStream(text: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const words = text.split(/(?<=\s)/);
  let i = 0;
  return new ReadableStream({
    async pull(controller) {
      if (i >= words.length) return controller.close();
      controller.enqueue(enc.encode(words.slice(i, i + 3).join("")));
      i += 3;
      await new Promise((r) => setTimeout(r, 25));
    },
  });
}

export function mockExplanation(req: ExplainRequest): string {
  const d = req.design_response.design;
  const p = req.design_response.physics;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  if (req.audience === "homeowner") {
    return [
      d.pv.include ? `We suggest ${d.pv.kwp?.toFixed(1)} kWp of solar panels on your roof.` : "We do not suggest solar panels for now.",
      d.battery.include ? `A ${d.battery.kwh} kWh battery stores daytime sun for the evening.` : "A battery would not pay off for you yet.",
      d.wallbox.include ? "A wallbox lets you charge your car with your own solar power." : "",
      `Together you would cover about ${pct(p.autarky)} of your electricity yourself.`,
      "(Sample text: the live explanation comes from the engine.)",
    ].filter(Boolean).join(" ");
  }
  return [
    ...d.pv.reasons.map((r) => r.replace("[mock] ", "")),
    ...(d.battery.include ? d.battery.reasons.map((r) => r.replace("[mock] ", "")) : []),
    `Self-consumption ${pct(p.self_consumption)}, autarky ${pct(p.autarky)}.`,
    "(Mock explanation: the engine is not connected.)",
  ].join(" ");
}

export const MOCK_PROJECT_IDS = ["mock-a1f3c2", "mock-b72e90", "mock-c0d4e8", "mock-d93a15", "mock-e5b7f1"];

export function mockProject(id: string): ProjectResponse {
  const r = seeded(hash(id));
  const annual = Math.round((3000 + r() * 5000) / 100) * 100;
  const hasEv = r() > 0.6;
  const home: Home = {
    annual_kwh: annual, price_eur_kwh: 0.32, load_profile: "H0", has_ev: hasEv, ev_km_year: hasEv ? 15000 : null,
    existing_pv_kwp: null, existing_battery_kwh: null, heating: r() > 0.5 ? "Gas" : "Oil", heating_demand_kwh: null,
    roof_type: null, house_sqm: null, inhabitants: null,
  };
  const ours = mockDesign({ installer: DEFAULT_INSTALLER, home, locks: EMPTY_LOCKS });
  const expPv = snapPv((ours.design.pv.kwp ?? 0) + (r() - 0.5) * 3);
  const variants = [0, 1].map((i) => ({
    option_number: i + 1,
    is_primary: i === 0,
    pv_kwp: i === 0 ? expPv : snapPv(expPv + 1.8),
    battery_kwh: snapBattery(expPv + (i === 0 ? 0 : 3)),
    has_wallbox: hasEv,
    heatpump_kw: null,
  }));
  return { project_id: id, installer: DEFAULT_INSTALLER, home, expert: variants[0], variants, ours };
}

/** Placeholder metrics with the engine's real names (engine/evaluate.py). Rates are PERCENT (0-100), MAE in kWp/kWh.
 *  Numbers copied from engine/README.md (interim labels) so the layout is realistic; flagged offline in the UI. */
const m = (o: Record<string, number>) => o;
export const MOCK_EVAL: EvalResponse = {
  labels_source: "offline placeholder (engine/README.md numbers)",
  baselines: ["baseline_kwh_per_1000", "baseline_band_median"],
  protocol: { split: "grouped by customer, stratified by installer", test_size: 0.2, seed: 42, n_test: 323 },
  metrics: {
    design_model: m({ n_projects: 323, has_pv_accuracy: 90, has_battery_accuracy: 89, has_wallbox_accuracy: 73, has_heatpump_accuracy: 99,
      pv_kwp_mae: 3.36, pv_kwp_mae_when_both_pv: 2.7, pv_kwp_mae_all_projects: 2.97, battery_kwh_mae_when_both_battery: 2.86,
      battery_within_one_step_pct: 53, pv_variant_hit_tolerant_pct: 41, battery_variant_hit_tolerant_pct: 54 }),
    baseline_band_median: m({ n_projects: 323, has_pv_accuracy: 81, has_battery_accuracy: 89, has_wallbox_accuracy: 72, has_heatpump_accuracy: 99,
      pv_kwp_mae: 2.93, pv_kwp_mae_when_both_pv: 2.93, pv_kwp_mae_all_projects: 3.91, battery_kwh_mae_when_both_battery: 3.08,
      battery_within_one_step_pct: 51, pv_variant_hit_tolerant_pct: 28, battery_variant_hit_tolerant_pct: 50 }),
    baseline_kwh_per_1000: m({ n_projects: 323, has_pv_accuracy: 81, has_battery_accuracy: 89, has_wallbox_accuracy: 72, has_heatpump_accuracy: 99,
      pv_kwp_mae: 5.29, pv_kwp_mae_when_both_pv: 5.22, pv_kwp_mae_all_projects: 5.08, battery_kwh_mae_when_both_battery: 3.07,
      battery_within_one_step_pct: 42, pv_variant_hit_tolerant_pct: 11, battery_variant_hit_tolerant_pct: 41 }),
  },
  by_installer: {},
  transfer: {},
};

