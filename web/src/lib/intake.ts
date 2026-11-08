/**
 * POST /api/intake: the typed twin of the voice agent's create_design. The answers (voice-agent field names) go
 * through the SAME normaliseFacts and Google-roof step as a call, then the engine designs. Nothing is stored here:
 * the page saves the draft through /api/designs once the planner finishes, so /live never mistakes a typed intake
 * for an incoming call. No LLM is involved; the engine picks every size.
 */
import { DEFAULT_INSTALLER } from "./engine";
import type { SolarResult } from "./solar";
import { EMPTY_LOCKS, type DesignResponse, type Home } from "./types";
import { applyGoogleRoof, hasUsageFacts, normaliseFacts, withTimeout, type NormalisedFacts, type VoiceDeps, type VoiceFacts } from "./voice";

const SOLAR_MS = 4000; // the roof is looked up once per address (lookupSolar caches it), so the first answer may wait
const ENGINE_MS = 8000;
const MAX_BODY_FIELDS = 30;

/**
 * A site-visit form's fields (/visit) in the voice agent's vocabulary. Every field is optional; the values are the
 * ones a form naturally has (booleans, numbers, enum keys). factsFromForm gives the same facts and the same engine
 * home as a call or /intake with the same answers, so all three entry points design identically.
 */
export interface FormFields {
  customer_name?: string | null;
  address?: string | null;
  /** true / false / null (don't know) */
  has_existing_pv?: boolean | null;
  existing_pv_kwp?: number | null;
  existing_battery_kwh?: number | null;
  /** give one of the two; a stated use wins over the bill */
  annual_kwh?: number | null;
  monthly_bill_eur?: number | null;
  /** people in the home (number, or words like "couple with two kids") */
  household?: number | string | null;
  daytime_presence?: boolean | null;
  /** "no" | "yes" or "now" (drives one today) | "planned"; booleans work too */
  has_ev?: "no" | "yes" | "now" | "planned" | boolean | null;
  ev_km_year?: number | null;
  /** gas | oil | heatpump | electric | district | wood | other */
  heating?: string | null;
  heating_age_years?: number | null;
  /** concrete_tile | clay_tile | flat | metal | slate | other */
  roof_type?: string | null;
  /** south | south_east | south_west | east_west | east | west | north; leave empty to use Google's roof */
  roof_direction?: string | null;
  wishes?: string | null;
  notes?: string | null;
}

/** Empty form values are "not answered" (never a value); "now" is the form's word for a car they already drive. */
function formAnswers(fields: FormFields): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) if (v != null && v !== "") raw[k] = v;
  if (raw.has_ev === "now") raw.has_ev = "yes";
  return raw;
}

/** Form fields → the voice pipeline's facts, engine home and stated assumptions (no Google roof: see formDraft). */
export function factsFromForm(fields: FormFields): NormalisedFacts {
  return normaliseFacts(formAnswers(fields));
}

/**
 * Form fields → the full draft input, exactly as /intake and create_design build it: facts + Google's roof for the
 * address + the engine's design (null until use, bill or household is known). Server-side only.
 */
export function formDraft(fields: FormFields, deps: Pick<VoiceDeps, "design" | "solar" | "installer">): Promise<IntakeReply> {
  return intakePreview(formAnswers(fields), deps);
}

export interface IntakeReply {
  facts: VoiceFacts;
  home: Home;
  assumptions: string[];
  /** Enough to draft without inventing the household's use (use, bill or household size given). */
  ready: boolean;
  design: DesignResponse | null;
  /** Set when `ready` but the engine failed or took longer than 8 s. */
  design_error?: string;
  solar: SolarResult | null;
}

export async function intakePreview(answers: Record<string, unknown>, deps: Pick<VoiceDeps, "design" | "solar" | "installer">): Promise<IntakeReply> {
  const { facts, home, assumptions } = normaliseFacts(answers);
  const solar = facts.address ? await withTimeout(deps.solar(facts.address), SOLAR_MS, "intake solar") : null;
  applyGoogleRoof(home, solar, assumptions);
  const ready = hasUsageFacts(answers);
  if (!ready) return { facts, home, assumptions, ready, design: null, solar };
  // withTimeout turns a failure or a timeout into null (logged); the page then says the planner drafts it
  const design = await withTimeout(deps.design({ installer: deps.installer || DEFAULT_INSTALLER, home, locks: EMPTY_LOCKS }), ENGINE_MS, "intake engine");
  const design_error = design ? undefined : "engine_unavailable";
  return { facts, home, assumptions, ready, design, ...(design_error ? { design_error } : {}), solar };
}

export async function handleIntake(req: Request, deps: Pick<VoiceDeps, "design" | "solar" | "installer">): Promise<Response> {
  let body: { answers?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  const answers = body?.answers;
  if (!answers || typeof answers !== "object" || Array.isArray(answers) || Object.keys(answers).length > MAX_BODY_FIELDS) {
    return Response.json({ error: "answers must be an object of facts" }, { status: 400 });
  }
  return Response.json(await intakePreview(answers as Record<string, unknown>, deps));
}
