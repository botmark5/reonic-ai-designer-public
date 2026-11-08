/** The site-visit form's state and its mapping to the voice pipeline's fact keys (normaliseFacts in lib/voice.ts). */

export type YesNo = "yes" | "no" | "unknown";
export type Ev = "no" | "now" | "planned";

export interface VisitForm {
  customer_name: string;
  address: string;
  existing_pv: YesNo | null;
  existing_pv_kwp: string;
  use_mode: "kwh" | "bill";
  annual_kwh: string;
  monthly_bill_eur: string;
  household: number | null;
  daytime: YesNo | null;
  ev: Ev | null;
  ev_km_year: string;
  heating: string | null;
  heating_age_years: string;
  roof_type: string | null;
  roof_direction: string | null; // null = from Google (the address)
  wishes: string;
}

export const EMPTY_VISIT: VisitForm = {
  customer_name: "", address: "", existing_pv: null, existing_pv_kwp: "", use_mode: "kwh", annual_kwh: "", monthly_bill_eur: "",
  household: null, daytime: null, ev: null, ev_km_year: "", heating: null, heating_age_years: "", roof_type: null, roof_direction: null,
  wishes: "",
};

const num = (s: string): number | null => {
  const n = Number(s.replace(/[\s.,](?=\d{3}\b)/g, "").replace(",", "."));
  return s.trim() && Number.isFinite(n) && n > 0 ? n : null;
};
const text = (s: string) => (s.trim() ? s.trim() : null);
const yn = (v: YesNo | null) => (v === "yes" ? "yes" : v === "no" ? "no" : null);

/** Only what was actually answered; empty answers stay null so the pipeline never mistakes them for facts. */
export function toVoiceFacts(f: VisitForm): Record<string, unknown> {
  const pv = yn(f.existing_pv);
  return {
    customer_name: text(f.customer_name),
    address: text(f.address),
    has_existing_pv: pv,
    existing_pv_kwp: pv === "yes" ? num(f.existing_pv_kwp) : null,
    annual_kwh: f.use_mode === "kwh" ? num(f.annual_kwh) : null,
    monthly_bill_eur: f.use_mode === "bill" ? num(f.monthly_bill_eur) : null,
    household: f.household,
    daytime_presence: yn(f.daytime),
    has_ev: f.ev === "now" ? "yes" : f.ev === "planned" ? "planned" : f.ev === "no" ? "no" : null,
    ev_km_year: f.ev === "now" || f.ev === "planned" ? num(f.ev_km_year) : null,
    heating: f.heating,
    heating_age_years: f.heating ? num(f.heating_age_years) : null,
    roof_type: f.roof_type,
    roof_direction: f.roof_direction,
    wishes: text(f.wishes),
  };
}

export function canSubmit(f: VisitForm): boolean {
  return f.address.trim().length >= 5;
}

export type StepKey = "house" | "model" | "panels" | "parts" | "ready";
export type StepState = "waiting" | "active" | "done" | "failed";
export interface VisitStep {
  key: StepKey;
  state: StepState;
  detail?: string;
}
export const STEP_LABEL: Record<StepKey, string> = {
  house: "Found the house",
  model: "Built the 3D model",
  panels: "Placed the solar panels",
  parts: "Added battery, wallbox and heat pump",
  ready: "Draft ready",
};

/** What the house shows while the steps complete (the same build-up as /live). */
export function revealFromSteps(steps: VisitStep[]) {
  const done = (k: StepKey) => steps.some((s) => s.key === k && s.state === "done");
  return { shell: done("house"), roof: done("house"), warm: done("model"), panels: done("panels"), inverter: done("panels"), parts: done("parts") };
}
