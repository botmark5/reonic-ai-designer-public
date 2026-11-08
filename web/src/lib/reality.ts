/**
 * Ours vs the expert, per component, with the same tolerances as engine/evaluate.py:
 * PV ±1 kWp, battery ±1 catalogue step, and anything inside the expert's offered variant range counts as a hit.
 */
import type { DesignResponse, ExpertVariant } from "./types";

export type VerdictKind = "match" | "range" | "close" | "option" | "off" | "missing" | "extra";
export interface Verdict {
  kind: VerdictKind;
  label: string;
  hit: boolean;
}

export interface OurSizes {
  pv: number | null; // null = none
  battery: number | null;
  wallbox: boolean;
  heatpump: number | null;
  heatpumpOption: number | null; // heat pump offered as a customer option
}

const PV_TOL = 1;
const V = (kind: VerdictKind, label: string): Verdict => ({ kind, label, hit: ["match", "range", "close", "option"].includes(kind) });

/** engine/evaluate.py step_index: 0 = no battery, 1 = smallest catalogue size, ... (nearest size). */
export function stepIndex(kwh: number | null, catalogue: number[]): number {
  const steps = [0, ...[...new Set(catalogue)].sort((x, y) => x - y)];
  const v = kwh ?? 0;
  return steps.reduce((best, s, i) => (Math.abs(s - v) < Math.abs(steps[best] - v) ? i : best), 0);
}

function sizeVerdict(ours: number | null, expert: (number | null)[], primary: number | null, tol: (a: number, b: number) => boolean): Verdict {
  const offered = expert.filter((x): x is number => x != null && x > 0);
  const oursYes = ours != null && ours > 0;
  if (!offered.length) return oursYes ? V("extra", "Expert offered none") : V("match", "Match");
  if (!oursYes) return V("missing", "Expert offered one");
  const p = primary && primary > 0 ? primary : offered[0];
  if (tol(ours!, p)) return V("match", "Match");
  const lo = Math.min(...offered), hi = Math.max(...offered);
  if (offered.length > 1 && ours! >= lo - 1e-9 && ours! <= hi + 1e-9) return V("range", "Inside offered range");
  if (offered.length > 1 && (tol(ours!, lo) || tol(ours!, hi))) return V("range", "At the edge of the offered range");
  return V("off", "Different from the expert");
}

export function verdicts(ours: OurSizes, variants: ExpertVariant[], batteryCatalogue: number[]) {
  const primary = variants.find((v) => v.is_primary) ?? variants[0];
  const pv = sizeVerdict(ours.pv, variants.map((v) => v.pv_kwp), primary?.pv_kwp ?? null, (a, b) => Math.abs(a - b) <= PV_TOL + 1e-9);

  // Battery exactly like evaluate.py: "no battery" is step 0, a hit is within one step of the offered range.
  const steps = variants.map((x) => stepIndex(x.battery_kwh, batteryCatalogue));
  const lo = Math.min(...steps), hi = Math.max(...steps);
  const sOurs = stepIndex(ours.battery, batteryCatalogue);
  const sPrimary = stepIndex(primary?.battery_kwh ?? null, batteryCatalogue);
  const battery =
    sOurs === sPrimary
      ? V("match", "Match")
      : variants.length > 1 && sOurs >= lo && sOurs <= hi
        ? V("range", "Inside offered range")
        : sOurs >= lo - 1 && sOurs <= hi + 1
          ? V("close", "One size step away")
          : sOurs === 0
            ? V("missing", "Expert offered one")
            : hi === 0
              ? V("extra", "Expert offered none")
              : V("off", "Different from the expert");

  // Wallbox and heat pump yes/no are scored against the expert's primary option (as in the metrics).
  const expertWb = !!primary?.has_wallbox;
  const wallbox = ours.wallbox === expertWb ? V("match", "Match") : ours.wallbox ? V("extra", "Expert offered none") : V("missing", "Expert offered one");

  const expertHp = (primary?.heatpump_kw ?? 0) > 0;
  const oursHp = (ours.heatpump ?? 0) > 0;
  const heatpump = expertHp
    ? oursHp
      ? V("match", "Match")
      : ours.heatpumpOption
        ? V("option", "Offered as customer option")
        : V("missing", "Expert offered one")
    : oursHp
      ? V("extra", "Expert offered none")
      : V("match", "Match");

  return { pv, battery, wallbox, heatpump };
}

// ---------------------------------------------------------------------------
// Headline metrics: our model vs the BEST simple baseline for each metric (named), read live from /eval.
// ---------------------------------------------------------------------------
export interface HeadlineDef {
  key: string;
  label: string;
  better: "lower" | "higher";
  unit: "kWp" | "%";
  note?: string;
}

export const HEADLINES: HeadlineDef[] = [
  { key: "pv_kwp_mae_all_projects", label: "Solar size error, all homes", better: "lower", unit: "kWp", note: "An unwanted or missing system counts as an error." },
  { key: "pv_variant_hit_tolerant_pct", label: "Solar inside the expert's range", better: "higher", unit: "%", note: "Within 1 kWp of any variant the expert offered." },
  { key: "pv_kwp_mae_when_both_pv", label: "Solar size error, where both chose solar", better: "lower", unit: "kWp" },
  { key: "has_battery_accuracy", label: "Battery yes or no right", better: "higher", unit: "%", note: "The simple rule always guesses the majority answer." },
  { key: "has_wallbox_accuracy", label: "Wallbox yes or no right", better: "higher", unit: "%", note: "The simple rule always guesses the majority answer." },
];

export const BASELINE_NAME: Record<string, string> = {
  baseline_band_median: "consumption-band median",
  baseline_kwh_per_1000: "kWh ÷ 1000 rule",
  baseline_kwp_per_mwh: "kWp-per-MWh rule",
};

export interface Headline extends HeadlineDef {
  ours: number | null;
  base: number | null;
  baseName: string | null;
  /** null = no comparison possible, or level with the rule */
  wins: boolean | null;
  tie: boolean;
  /** inside the noise: ≤ 2 points for %, ≤ 5 % of the rule's error for kWp (pitch facts call these "level") */
  level: boolean;
}

export const LEVEL_PCT_POINTS = 2;
export const LEVEL_KWP_SHARE = 0.05;

type Metrics = Record<string, Record<string, number | null | undefined>>;

/** Add-on sales (battery retrofits, extensions, wallbox only): a separate small block, never mixed into the headline. */
export const ADDON_HEADLINES: HeadlineDef[] = [
  { key: "has_pv_accuracy", label: "No new solar where none was sold", better: "higher", unit: "%" },
  { key: "has_battery_accuracy", label: "Battery yes or no right", better: "higher", unit: "%" },
  { key: "battery_within_one_step_pct", label: "Battery within one size step", better: "higher", unit: "%" },
];

/** Share of held-out homes whose expert PV lies inside our P10–P90 range (target 80 %). Key names tolerated. */
export const COVERAGE_KEYS = ["pv_interval_coverage_pct", "pv_p10_p90_coverage_pct", "pv_range_coverage_pct"];
export function coverage(m: Record<string, number | null | undefined> | undefined): number | null {
  for (const k of COVERAGE_KEYS) if (typeof m?.[k] === "number") return m[k] as number;
  return null;
}

/** Minimum homes behind a coverage number before we show it (pv_n = homes where both chose solar). */
export const MIN_COVERAGE_N = 20;

type EvalLike = {
  metrics: Metrics;
  segments?: Record<string, Metrics>;
  with_existing_pv_answer?: { metrics?: Metrics; segments?: Record<string, Metrics> };
};
const nonEmpty = (m: Metrics | undefined) => (m && Object.keys(m).length ? m : null);

/**
 * Where the headline numbers come from (audit 8 Nov, engine/RESULTS.md "How to read answered").
 * In the evaluation the answer to "Solar already on the roof?" is DERIVED FROM THE EXPERT OFFER, so answered-mode
 * yes/no and all-homes numbers restate the label and are not accuracy. Two places are fair:
 *   - new full systems: every home gets the same answer ("new system"), so it carries no information about sizes
 *     -> the headline tiles use the answered full_designs slice when /eval has it (else the unanswered one, else all homes);
 *   - everything else (all homes, add-on sales) is shown WITHOUT the answer, as the data records it.
 * The answered all-homes numbers only appear in the explicit what-if card of the view.
 */
export function headlineSource(e: EvalLike) {
  const a = e.with_existing_pv_answer;
  const fullAnswered = nonEmpty(a?.segments?.full_designs);
  const full = fullAnswered ?? nonEmpty(e.segments?.full_designs);
  return {
    metrics: full ?? e.metrics,
    overall: e.metrics,
    fullOnly: !!full,
    /** add-on sales without the answer; the answered version only when /eval has no unanswered segments at all */
    addOns: nonEmpty(e.segments?.add_ons) ?? (e.segments ? null : nonEmpty(a?.segments?.add_ons)),
    /** true when the new-systems tiles come from the answered slice (planner said "new system") */
    answered: !!fullAnswered,
  };
}

/** Coverage only when enough homes stand behind it (pv_n >= MIN_COVERAGE_N; older /eval without pv_n: n_projects). */
export function trustedCoverage(m: Record<string, number | null | undefined> | undefined): number | null {
  const c = coverage(m);
  const nBoth = typeof m?.pv_n === "number" ? m.pv_n : typeof m?.n_projects === "number" ? m.n_projects : null;
  return c != null && nBoth != null && nBoth >= MIN_COVERAGE_N ? c : null;
}

/** Share of homes where the expert's PV is within 1.5 kWp of one of our top 3 options (issue #57); same n guard as coverage. */
export function top3(m: Record<string, number | null | undefined> | undefined): number | null {
  const v = m?.["pv_top3_within_1.5_pct"];
  const nBoth = typeof m?.pv_n === "number" ? m.pv_n : null;
  return typeof v === "number" && nBoth != null && nBoth >= MIN_COVERAGE_N ? v : null;
}

export function headlines(metrics: Metrics, model = "design_model", defs: HeadlineDef[] = HEADLINES): Headline[] {
  const baselines = Object.keys(metrics).filter((k) => k.startsWith("baseline_"));
  return defs.map((h) => {
    const ours = metrics[model]?.[h.key] ?? null;
    let base: number | null = null;
    let baseName: string | null = null;
    for (const b of baselines) {
      const v = metrics[b]?.[h.key];
      if (typeof v !== "number") continue;
      if (base == null || (h.better === "lower" ? v < base : v > base)) {
        base = v;
        baseName = BASELINE_NAME[b] ?? b.replace("baseline_", "").replace(/_/g, " ");
      }
    }
    // compare at the precision shown (kWp 2 decimals, % whole numbers): a tie on screen is a tie, not a loss
    const shown = (x: number) => (h.unit === "kWp" ? Math.round(x * 100) : Math.round(x));
    const tie = typeof ours === "number" && base != null && shown(ours) === shown(base);
    const level =
      typeof ours === "number" &&
      base != null &&
      (tie || (h.unit === "%" ? Math.abs(ours - base) <= LEVEL_PCT_POINTS : Math.abs(ours - base) <= LEVEL_KWP_SHARE * Math.abs(base) + 1e-9));
    const wins = ours == null || base == null || level ? null : h.better === "lower" ? ours < base : ours > base;
    return { ...h, ours: typeof ours === "number" ? ours : null, base, baseName, wins, tie, level };
  });
}

/**
 * The expert's sale in our response shape, so the same 3D stage can draw it: the primary variant's sizes, our
 * response for everything else (the stage reads sizes from `design`). None where the expert sold none.
 */
export function expertDesign(ours: DesignResponse, variants: ExpertVariant[]): DesignResponse {
  const p = variants.find((x) => x.is_primary) ?? variants[0];
  const d = ours.design;
  const pv = (p?.pv_kwp ?? 0) > 0 ? p!.pv_kwp : null;
  const bat = (p?.battery_kwh ?? 0) > 0 ? p!.battery_kwh : null;
  const hp = (p?.heatpump_kw ?? 0) > 0 ? p!.heatpump_kw : null;
  const wb = !!p?.has_wallbox;
  return {
    ...ours,
    design: {
      pv: { ...d.pv, include: pv != null, kwp: pv, reasons: [], alternatives: [] },
      battery: { ...d.battery, include: bat != null, kwh: bat, reasons: [], alternatives: [] },
      wallbox: { ...d.wallbox, include: wb, kw: wb ? (d.wallbox.kw ?? 11) : null, reasons: [] },
      heatpump: { ...d.heatpump, include: hp != null, kw: hp, reasons: [] },
    },
    options: undefined,
  };
}

/** Plain chip labels for the curated cases (engine demo_projects roles). */
export const ROLE_LABEL: Record<string, string> = {
  two_houses_typical_pv_battery: "Typical home",
  two_houses_ev_wallbox: "EV owner",
  two_houses_large_home: "Large home",
  typical_pv_battery: "Typical home",
  ev_wallbox: "EV owner",
  heatpump_option: "Heat pump case",
  battery_retrofit: "Battery retrofit",
  experts_disagree: "Experts disagree",
};

/** Case chips in engine order; an older case is hidden when its curated two-houses version exists. */
export function caseChips<T extends { role: string }>(demos: T[]): (T & { label: string })[] {
  const roles = new Set(demos.map((d) => d.role));
  return demos
    .filter((d) => !roles.has(`two_houses_${d.role}`))
    .map((d) => ({ ...d, label: ROLE_LABEL[d.role] ?? d.role.replace(/^two_houses_/, "").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) }));
}
