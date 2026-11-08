import type { Home } from "@/lib/types";

/** Facts as the voice agent stores them (lib/voice.ts VoiceFacts), all optional. */
export interface Facts {
  customer_name?: string | null;
  address?: string | null;
  annual_kwh?: number | null;
  monthly_bill_eur?: number | null;
  household?: number | null;
  has_ev?: boolean | null;
  ev_km_year?: number | null;
  heating?: string | null;
  heating_age_years?: number | null;
  roof_type?: string | null;
  roof_direction?: string | null;
  has_existing_pv?: boolean | null;
  existing_pv_kwp?: number | null;
  existing_battery_kwh?: number | null;
  /** /live only: yearly use the voice backend estimated (e.g. from household size); never sent as a caller fact. */
  annual_kwh_estimate?: number | null;
}

export const pretty = (s: string) => s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

/** The call's facts as an engine Home (same rules the planner inbox uses). */
export function factsToHome(f: Facts): Home {
  return {
    annual_kwh: f.annual_kwh ?? (f.monthly_bill_eur ? Math.round((f.monthly_bill_eur * 12) / 0.35 / 100) * 100 : 4000),
    price_eur_kwh: 0.32, load_profile: "H0", has_ev: !!f.has_ev, ev_km_year: f.has_ev ? (f.ev_km_year ?? 15000) : null,
    existing_pv_kwp: f.existing_pv_kwp ?? null, existing_battery_kwh: f.existing_battery_kwh ?? null,
    heating: f.heating ? pretty(f.heating) : null, heating_demand_kwh: null,
    roof_type: f.roof_type ? pretty(f.roof_type) : null, house_sqm: null, inhabitants: f.household ?? null,
    has_existing_pv: f.has_existing_pv ?? (f.existing_pv_kwp != null ? f.existing_pv_kwp > 0 : null),
    demand_is_default: f.annual_kwh != null ? false : null,
  };
}

/** The engine Home fields (lib/types Home). calls.facts also carries bookkeeping and the caller's display answers. */
const HOME_KEYS: readonly (keyof Home)[] = [
  "annual_kwh", "price_eur_kwh", "load_profile", "has_ev", "ev_km_year", "existing_pv_kwp", "existing_battery_kwh", "heating",
  "heating_demand_kwh", "roof_type", "house_sqm", "inhabitants", "has_existing_pv", "demand_is_default", "existing_wallbox",
  "orientation_deg", "tilt_deg", "offer_date", "roof_max_kwp", "roof_azimuth", "roof_pitch",
];

export interface LiveCallState {
  /** What the caller said (chips). */
  facts: Facts;
  /** What goes to the engine. */
  home: Home;
  /** Enough to draft (a yearly use is known or derived). */
  ready: boolean;
  location?: { lat: number; lng: number; address?: string };
  /** Google's roof for the CURRENT address (d-voice looks it up during the call). */
  solar?: unknown;
  updatedAt?: string;
}

/**
 * A calls row → the /live view. Rows written by update_facts carry the engine Home d-voice derived (the same home
 * create_design sends) plus the caller's raw answers under `voice`; older rows hold the answers directly.
 */
export function callToLive(row: { customer_name: string | null; address: string | null; facts: unknown }): LiveCallState {
  const raw = (row.facts && typeof row.facts === "object" ? row.facts : {}) as Record<string, unknown>;
  const voice = raw.voice && typeof raw.voice === "object" ? (raw.voice as Facts) : null;
  const solar = raw.solar as { lat?: unknown; lng?: unknown } | undefined;
  const address = row.address ?? voice?.address ?? (raw.address as string | undefined) ?? null;
  // a roof looked up for an earlier address (the caller corrected it) is not this house
  const solarFor = typeof raw.solar_for === "string" ? raw.solar_for : null;
  const solarOk = !!solar && (!solarFor || solarFor === address);
  const location =
    solarOk && solar && typeof solar.lat === "number" && typeof solar.lng === "number" && Number.isFinite(solar.lat) && Number.isFinite(solar.lng)
      ? { lat: solar.lat, lng: solar.lng, address: address ?? undefined }
      : undefined;
  const updatedAt = typeof raw.facts_updated_at === "string" ? raw.facts_updated_at : undefined;
  if (!voice) {
    const facts = { ...(raw as Facts), customer_name: (raw.customer_name as string) ?? row.customer_name, address };
    return { facts, home: factsToHome(facts), ready: facts.annual_kwh != null || facts.monthly_bill_eur != null, location, solar: solarOk ? solar : undefined, updatedAt };
  }
  const home = Object.fromEntries(HOME_KEYS.filter((k) => k in raw).map((k) => [k, raw[k]])) as unknown as Home;
  // The derived home always has a yearly use (4,000 kWh default), so "known" means the caller SAID a consumption fact:
  // the kWh, the bill, or the household size (then d-voice's estimate is shown as one).
  const said = voice.annual_kwh != null || voice.monthly_bill_eur != null || voice.household != null;
  const hasKwh = typeof home.annual_kwh === "number" && home.annual_kwh > 0;
  const estimate = voice.annual_kwh == null && voice.monthly_bill_eur == null && voice.household != null && hasKwh ? home.annual_kwh : null;
  const facts: Facts = { ...voice, customer_name: row.customer_name ?? voice.customer_name ?? null, address, annual_kwh_estimate: estimate };
  return { facts, home, ready: said && hasKwh, location, solar: solarOk ? solar : undefined, updatedAt };
}

const HEARD_LABEL: Record<string, string> = {
  customer_name: "Name", address: "Address", has_existing_pv: "Existing solar", existing_pv_kwp: "Existing solar size",
  existing_battery_kwh: "Existing battery", annual_kwh: "Yearly use", monthly_bill_eur: "Monthly bill", household: "Household",
  daytime_presence: "Home during the day", has_ev: "Electric car", ev_km_year: "Driving", heating: "Heating",
  heating_age_years: "Heating age", roof_type: "Roof", roof_direction: "Roof direction", wishes: "Wishes", notes: "Notes",
};

/**
 * Arrival order of the caller's answers. calls.facts.stated is jsonb (key order is not the spoken order), so /live
 * remembers the order it first saw each key; keys this update changed (updated_fields) come last.
 * Returns the same array when nothing is new.
 */
export function nextHeardOrder(prev: string[], stated: Record<string, unknown> | null | undefined, updated: string[] | null | undefined): string[] {
  if (!stated) return prev;
  const seen = new Set(prev);
  // answers missed between two polls first, then the ones this update changed (said most recently)
  const latest = (updated ?? []).filter((k) => k in stated);
  const fresh = [...Object.keys(stated).filter((k) => !latest.includes(k)), ...latest].filter((k) => !seen.has(k) && (seen.add(k), true));
  return fresh.length ? [...prev, ...fresh] : prev;
}

/** The answers as the agent heard them, labelled, in arrival order (shown until the full transcript arrives). */
export function heardTurns(stated: Record<string, unknown> | null | undefined, order: string[]): { role: "customer"; text: string }[] {
  if (!stated) return [];
  return order
    .filter((k) => (typeof stated[k] === "string" && (stated[k] as string).trim()) || typeof stated[k] === "number")
    .map((k) => ({ role: "customer" as const, text: `${HEARD_LABEL[k] ?? pretty(k)}: ${String(stated[k])}` }));
}
