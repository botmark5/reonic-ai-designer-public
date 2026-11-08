/**
 * Engine API types. Source of truth: docs/api.md (v0). Fields the engine returns on top of v0
 * (see engine/README.md "API additions") are optional here, so the mock and older engines still type-check.
 * Shared by sessions B (web), C (3D house) and D (voice): change only together with docs/api.md.
 */

export type InstallerId = string; // e.g. "installer_a", "installer_b"

export type LoadProfile = "H0" | (string & {});
export type Heating = "Gas" | "Oil" | "Heat pump" | "Electric" | "District" | "Wood" | (string & {});

/** The home as the planner (or the voice agent) describes it. */
export interface Home {
  annual_kwh: number;
  price_eur_kwh: number | null;
  load_profile: LoadProfile | null;
  has_ev: boolean;
  ev_km_year: number | null;
  existing_pv_kwp: number | null;
  existing_battery_kwh: number | null;
  heating: Heating | null;
  heating_demand_kwh: number | null;
  roof_type: string | null;
  house_sqm: number | null;
  inhabitants: number | null;
  // optional extras accepted by the engine (not in api.md v0)
  /** "Is there already PV on the roof?" true / false / null = not asked. The engine's strongest input (engine PR #9). */
  has_existing_pv?: boolean | null;
  /** true only when annual_kwh was left at the dataset default (4,500); false once the planner typed or confirmed it.
   *  Engine support pending (extras are ignored until Cala adds it). */
  demand_is_default?: boolean | null;
  existing_wallbox?: boolean;
  orientation_deg?: number | null; // 180 = south
  tilt_deg?: number | null;
  offer_date?: string | null; // ISO date; empty = today
  /** Roof inputs (engine #27), filled from Google Solar when the address is known. undefined = never filled,
   *  null = removed by the planner. The cap limits PV size; direction and pitch change yield, not size. */
  roof_max_kwp?: number | null;
  roof_azimuth?: number | null; // degrees clockwise from north, 180 = south
  roof_pitch?: number | null; // degrees
}

/** Components the planner has fixed. null = engine decides. 0 = "none" (no PV / no battery / no heat pump). */
export interface Locks {
  pv_kwp: number | null;
  battery_kwh: number | null;
  wallbox: boolean | null;
  heatpump_kw: number | null;
}

export type ComponentKey = "pv" | "battery" | "wallbox" | "heatpump";

export interface DesignRequest {
  installer: InstallerId;
  home: Home;
  locks: Locks;
}

interface ComponentBase {
  include: boolean;
  confidence: number; // 0..1
  reasons: string[];
}

export interface PvAlternative {
  kwp: number;
  share: number; // probability among the installer's standard sizes, 0..1
}

export interface PvDesign extends ComponentBase {
  kwp: number | null;
  range: [number, number];
  /** Up to two other sizes the installer sells that the engine finds plausible (engine PR #56). */
  alternatives?: PvAlternative[];
}

export interface BatteryAlternative {
  kwh: number;
  share: number; // probability among catalogue sizes, 0..1
}

export interface BatteryDesign extends ComponentBase {
  kwh: number | null;
  range: [number, number];
  alternatives?: BatteryAlternative[];
}

export interface WallboxDesign extends ComponentBase {
  kw: number | null;
}

export interface HeatpumpOptionInfo {
  available: boolean;
  kw: number | null;
  reasons: string[];
}

export interface HeatpumpDesign extends ComponentBase {
  kw: number | null;
  option?: HeatpumpOptionInfo;
}

export interface Design {
  pv: PvDesign;
  battery: BatteryDesign;
  wallbox: WallboxDesign;
  heatpump: HeatpumpDesign;
}

export type FlagLevel = "ok" | "info" | "warn" | "error";

export interface PhysicsFlag {
  component: ComponentKey | "home";
  level: FlagLevel;
  code: string;
  message: string;
}

export interface Physics {
  yield_kwh: number;
  self_consumption: number; // 0..1
  autarky: number; // 0..1
  warnings: string[];
  // engine extras
  load_kwh?: number;
  grid_import_kwh?: number;
  feed_in_kwh?: number;
  battery_cycles?: number;
  flags?: PhysicsFlag[];
  assumptions?: string[];
}

export interface Economics {
  capex_total_eur: number;
  savings_first_year_eur: number;
  payback_years: number | null;
  savings_lifetime_eur: number;
  assumptions: string[];
}

export interface VariantSummary {
  pv_kwp: number | null;
  battery_kwh: number | null;
  heatpump_kw: number | null;
  capex_total_eur: number;
  savings_first_year_eur: number;
  heating_savings_eur: number;
  payback_years: number | null;
  net_benefit_lifetime_eur: number;
  autarky: number;
  load_kwh: number;
}

/** The heat pump as a customer choice: the full design with and without it. */
export type HeatpumpChoice =
  | { available: false; reasons: string[] }
  | {
      available: true;
      included: boolean;
      kw: number;
      reasons: string[];
      with_heatpump: VariantSummary;
      without_heatpump: VariantSummary;
      difference: {
        extra_investment_eur: number;
        extra_savings_per_year_eur: number;
        extra_net_benefit_lifetime_eur: number;
      };
      how_to_choose?: string;
    };

export interface SimilarHome {
  project_id: string;
  annual_kwh: number;
  pv_kwp: number;
  battery_kwh: number | null;
  similarity: number; // 0..1
}

/**
 * Added by web/src/lib/engine.ts (not by the engine): who answered. "offline" = the built-in estimate was used
 * because ENGINE_URL is unset or the engine did not answer in time. Show the "offline estimate" badge then.
 */
export interface Served {
  source: "engine" | "offline";
  reason?: string; // why offline, e.g. "timeout after 4000 ms"
  ms: number; // round trip
}

/** facts_for_explanation.offer_type (engine PR #9). */
export type OfferType = "pv" | "battery_retrofit" | "wallbox_only" | "other";
export const OFFER_TYPE_LABEL: Record<OfferType, string> = {
  pv: "New solar system",
  battery_retrofit: "Battery add-on to existing solar",
  wallbox_only: "Wallbox only",
  other: "Order without solar or battery",
};

export interface DesignResponse {
  design: Design;
  physics: Physics;
  similar_homes: SimilarHome[];
  facts_for_explanation: Record<string, unknown>;
  model_version: string;
  // engine extras
  economics?: Economics;
  options?: { heatpump?: HeatpumpChoice };
  served?: Served;
}

/** The planner's chosen design, as sent to /validate. */
export interface PlannerDesign {
  pv_kwp: number | null;
  battery_kwh: number | null;
  wallbox: boolean | null;
  heatpump_kw: number | null;
}

export interface ValidateRequest {
  installer: InstallerId;
  home: Home;
  design: PlannerDesign;
}

export interface ValidationFlag {
  component: ComponentKey | "home";
  level: FlagLevel;
  percentile: number | null;
  message: string;
  code?: string;
}

export interface ValidateResponse {
  flags: ValidationFlag[];
  served?: Served;
}

export interface RefineRequest {
  text: string;
  home: Home;
  locks: Locks;
  installer?: InstallerId;
}

/** The live engine returns all fields (engine/README.md: {changes, summary, parsed_by, home, locks, design}). */
export interface RefineResponse {
  changes: Partial<Home> & Partial<Locks>;
  summary: string; // one line, e.g. "Added an EV with 15,000 km a year."
  parsed_by: string; // "claude" | "keywords" (engine) | "mock-keywords" (offline)
  home: Home; // the home after the changes
  locks: Locks; // the locks after the changes
  design: DesignResponse;
  served?: Served;
}

export type Audience = "planner" | "homeowner";

export interface ExplainRequest {
  design_response: DesignResponse;
  audience: Audience;
  language?: "en" | "de";
}

/**
 * Metric name -> value (engine/evaluate.py compute_metrics). Rates end in _accuracy or _pct and are PERCENT 0-100.
 * Main names: n_projects, has_{pv,battery,wallbox,heatpump}_accuracy, pv_kwp_mae, pv_kwp_mae_when_both_pv,
 * pv_kwp_mae_all_projects, pv_kwp_within_1.5_pct, battery_kwh_mae, battery_kwh_mae_when_both_battery,
 * battery_within_one_step_pct, pv_variant_hit_{strict,tolerant}_pct, battery_variant_hit_{strict,tolerant}_pct,
 * n_multi_option_projects.
 */
export type MetricSet = Record<string, number | null>;

/** Predictor keys in EvalResponse.metrics. */
export const PREDICTORS = {
  model: "design_model",
  bandMedian: "baseline_band_median",
  kwhPer1000: "baseline_kwh_per_1000",
} as const;

export interface EvalResponse {
  /** predictor name (model + baselines) -> metrics */
  metrics: Record<string, MetricSet>;
  /** predictor name -> installer -> metrics */
  by_installer: Record<string, Record<InstallerId, MetricSet>>;
  /** names of the baseline predictors: ["baseline_kwh_per_1000", "baseline_band_median"] */
  baselines: string[];
  // engine extras
  protocol?: Record<string, unknown>;
  /** "installerA->installerB" -> predictor -> metrics (trained on A, tested on B) */
  transfer?: Record<string, Record<string, MetricSet>>;
  labels_source?: string;
  /** report slice -> predictor -> metrics. "full_designs" = new full systems (the headline), "add_ons" = retrofits,
   *  extensions and wallbox-only sales; also "known_consumption", "full_designs_known_consumption". */
  segments?: Record<string, Record<string, MetricSet>>;
  /** consumption band ("0-2500", ..., "9000+") -> predictor -> metrics (engine #79; optional until it ships) */
  by_band?: Record<string, Record<string, MetricSet>>;
  /** same held-out evaluation when the planner answered "Solar already on the roof?" */
  with_existing_pv_answer?: { metrics?: Record<string, MetricSet>; segments?: Record<string, Record<string, MetricSet>> };
  served?: Served;
}

/** One option of an expert offer (a project can have several variants). */
export interface ExpertVariant {
  option_number: number;
  is_primary: boolean;
  pv_kwp: number | null;
  battery_kwh: number | null;
  has_wallbox: boolean | null;
  heatpump_kw: number | null;
}

export interface ProjectResponse {
  home: Home;
  expert: ExpertVariant | null;
  variants: ExpertVariant[];
  ours: DesignResponse | null;
  // engine extras
  project_id?: string;
  installer?: InstallerId;
  served?: Served;
  /** engine #47 (PR #82): `ours` was built with the planner's answer to "Solar already on the roof?", derived from the
   *  expert offer (battery-only = yes, new system = no). A what-if, never an accuracy. */
  answered?: boolean;
  planner_answer?: boolean | null;
}

/** GET /health (no key needed). */
export interface HealthResponse {
  status: "ok" | (string & {});
  model_version: string;
  labels_source: string;
  trained_on_projects: number;
  claude: boolean;
}

export const EMPTY_LOCKS: Locks = { pv_kwp: null, battery_kwh: null, wallbox: null, heatpump_kw: null };
