/**
 * Voice agent backend (session D): the ElevenLabs site-visit agent's server tool, its post-call webhook and the
 * homeowner "listen to your offer" explanation. Server-only.
 *
 * Rules (CLAUDE.md): the ENGINE decides every size. This file only turns spoken facts into an engine request, stores the
 * result, and phrases engine facts. Claude is used only to phrase (offerScript), never to size anything.
 * Never log secrets, tokens, signatures or headers.
 *
 * Env: ELEVENLABS_TOOL_SECRET, ELEVENLABS_WEBHOOK_SECRET, ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID, VOICE_TTS_ENABLED,
 *      ANTHROPIC_API_KEY, VOICE_INSTALLER (+ engine and Supabase env, see engine.ts / supabase.ts, solar.ts).
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_INSTALLER, engine, engineUrl } from "./engine";
import { allowRequest, clientKey, lookupSolar, roofFromSolar, type SolarResult } from "./solar";
import { getServerSupabase, type TranscriptTurn } from "./supabase";
import { EMPTY_LOCKS, type DesignRequest, type DesignResponse, type Home, type Locks } from "./types";
import staticVoiceCache from "./voice-cache.json";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
/** €/kWh used to turn a monthly bill into annual kWh (engine/config/economics.toml default_price_eur_kwh). */
export const BILL_PRICE_EUR_KWH = 0.35;
const HOUSEHOLD_KWH: Record<number, number> = { 1: 1500, 2: 2500, 3: 3500, 4: 4250 };
const HOUSEHOLD_KWH_5PLUS = 5000;
const DEFAULT_KWH = 4000;
const EV_KM_DEFAULT = 15000; // planner form and chat agent use the same default
const CREATE_BUDGET_MS = 2500; // the agent must be able to speak within ~3 s
const SOLAR_BUDGET_MS = 900;
const STORED_READ_MS = 900; // create-design: reading the answers update_facts stored
const POSTCALL_BUDGET_MS = 8000;
/** After create-design answered "pending": wait for the slow engine call, then retry once after the engine client's
 *  15 s outage cool-down (engine.ts COOLDOWN_MS). Routes set maxDuration = 60. */
export const LATE_TIMING = { lateMs: 10000, retryAfterMs: 16000, retryMs: 8000 };
const SIGNATURE_TOLERANCE_S = 30 * 60;
const EXPLAIN_MODEL = "claude-sonnet-5-5";

const HEATING: Record<string, string> = {
  gas: "Gas", oil: "Oil", heatpump: "Heatpump", heat_pump: "Heatpump", electric: "Electric",
  district: "District", wood: "Wood", other: "Other",
};
/** Compass azimuth (180 = south). East-west = 90: the engine rates a roof by its deviation from south, 90° for both faces. */
const ORIENTATION: Record<string, number> = {
  south: 180, south_east: 135, southeast: 135, south_west: 225, southwest: 225,
  east: 90, west: 270, north: 0, east_west: 90, eastwest: 90,
};
const ROOF_TYPES = ["concrete_tile", "clay_tile", "flat", "metal", "slate", "other"];
const EMPTY_WORDS = new Set(["", "unknown", "none", "null", "n/a", "na", "undefined", "not sure", "-"]);

// ---------------------------------------------------------------------------
// Parsing what the agent sends (strings, numbers, empty strings, "unknown")
// ---------------------------------------------------------------------------
export function parseNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const m = v.trim().match(/-?\d[\d.,]*/);
  if (!m) return null;
  let s = m[0].replace(/[.,]$/, "");
  s = /^-?\d{1,3}([.,]\d{3})+$/.test(s) ? s.replace(/[.,]/g, "") : s.replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const parsePositive = (v: unknown) => {
  const n = parseNumber(v);
  return n != null && n >= 0 ? n : null;
};

export function parseBool(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  const t = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (["yes", "true", "ja", "y", "1"].includes(t)) return true;
  if (["no", "false", "nein", "n", "0"].includes(t)) return false;
  return null;
}

/** EV answer: a car that is planned ("next year") counts as yes, because the wallbox goes in with the system. */
export function parseEv(v: unknown): boolean | null {
  const t = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (["planned", "soon", "next year", "geplant", "bald", "nächstes jahr"].includes(t)) return true;
  return parseBool(v);
}

export function parseText(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return EMPTY_WORDS.has(t.toLowerCase()) ? null : t;
}

const parseKey = (v: unknown) => parseText(v)?.toLowerCase().replace(/[\s-]+/g, "_") ?? null;

const HOUSEHOLD_MAX = 20;
const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eins: 1, eine: 1, einem: 1, einer: 1, zwei: 2, drei: 3, vier: 4, "fünf": 5, fuenf: 5, sechs: 6, sieben: 7, acht: 8, neun: 9, zehn: 10,
};
const nWord = `(\\d+|${Object.keys(NUMBER_WORDS).join("|")})`;
const toN = (w: string) => NUMBER_WORDS[w] ?? Number(w);

/** "family of four", "zu zweit", "couple with two kids", "5+", 4 → people in the household (1..20), else null. */
export function parseHousehold(v: unknown): number | null {
  const clamp = (n: number | null) => (n == null || !Number.isFinite(n) || n < 1 ? null : Math.min(Math.round(n), HOUSEHOLD_MAX));
  if (typeof v === "number") return clamp(v);
  const t = parseText(v)?.toLowerCase();
  if (!t) return null;
  // adults + children: "couple with two kids", "single parent with one child", "Paar mit zwei Kindern"
  const kids = t.match(new RegExp(`\\b${nWord}\\s+(kids?|child(ren)?|kinder?n?)\\b`));
  const adults = /\b(couple|paar|ehepaar|two adults|zwei erwachsene)\b/.test(t) ? 2
    : /\b(single parent|alleinerziehend\w*)\b/.test(t) ? 1 : null;
  if (kids && adults != null) return clamp(adults + toN(kids[1]));
  const zu = t.match(/\bzu\s*(zweit|dritt|viert|fünft|fuenft)\b/);
  if (zu) return { zweit: 2, dritt: 3, viert: 4, "fünft": 5, fuenft: 5 }[zu[1]] ?? null;
  const nums = [...t.matchAll(new RegExp(`\\b${nWord}\\b`, "g"))].map((m) => toN(m[1]));
  if (nums.length) return clamp(Math.max(...nums));
  if (/\b(single|alone|just me|myself|allein\w*|ich allein)\b/.test(t)) return 1;
  if (/\b(couple|paar|ehepaar|two of us|wife and i|husband and i|partner)\b/.test(t)) return 2;
  return null;
}

/** Is someone at home during the day? true / false / null (not asked or unclear). */
export function parsePresence(v: unknown): boolean | null {
  const b = parseBool(v);
  if (b != null) return b;
  const t = parseText(v)?.toLowerCase();
  if (!t) return null;
  if (/home ?office|work(s|ing)? from home|retired|rentner|pension|(mostly|usually|always) (at )?home|tagsüber zu ?hause|meist zu ?hause/.test(t)) return true;
  if (/full[- ]?time|vollzeit|(mostly|usually) (out|away)|not (at )?home|nicht zu ?hause|tagsüber weg|commut/.test(t)) return false;
  return null;
}

// ---------------------------------------------------------------------------
// Facts → engine Home
// ---------------------------------------------------------------------------
export interface VoiceFacts {
  conversation_id: string | null;
  customer_name: string | null;
  address: string | null;
  annual_kwh: number | null;
  monthly_bill_eur: number | null;
  household: number | null;
  daytime_presence: boolean | null;
  has_ev: boolean | null;
  ev_km_year: number | null;
  heating: string | null;
  heating_age_years: number | null;
  roof_type: string | null;
  roof_direction: string | null;
  has_existing_pv: boolean | null;
  existing_pv_kwp: number | null;
  existing_battery_kwh: number | null;
  wishes: string | null;
  notes: string | null;
}

export interface NormalisedFacts {
  facts: VoiceFacts;
  home: Home;
  assumptions: string[];
}

const fmtNum = (x: number) => String(Number(x.toFixed(2)));

export function normaliseFacts(raw: unknown): NormalisedFacts {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const facts: VoiceFacts = {
    conversation_id: parseText(r.conversation_id),
    customer_name: parseText(r.customer_name),
    address: parseText(r.address),
    annual_kwh: parsePositive(r.annual_kwh),
    monthly_bill_eur: parsePositive(r.monthly_bill_eur),
    household: parseHousehold(r.household),
    daytime_presence: parsePresence(r.daytime_presence),
    has_ev: parseEv(r.has_ev),
    ev_km_year: parsePositive(r.ev_km_year),
    heating: parseKey(r.heating),
    heating_age_years: parsePositive(r.heating_age_years),
    roof_type: parseKey(r.roof_type),
    roof_direction: parseKey(r.roof_direction),
    has_existing_pv: parseBool(r.has_existing_pv),
    existing_pv_kwp: parsePositive(r.existing_pv_kwp),
    existing_battery_kwh: parsePositive(r.existing_battery_kwh),
    wishes: parseText(r.wishes),
    notes: parseText(r.notes),
  };

  const assumptions: string[] = [];
  let annual = facts.annual_kwh && facts.annual_kwh > 0 ? facts.annual_kwh : null;
  // The caller's own figure (use or bill) is real demand, not the dataset's 4,500 kWh placeholder.
  const demandStated = annual != null || (facts.monthly_bill_eur ?? 0) > 0;
  if (annual == null && facts.monthly_bill_eur) {
    annual = Math.round((facts.monthly_bill_eur * 12) / BILL_PRICE_EUR_KWH / 100) * 100;
    assumptions.push(`Annual use estimated from a €${fmtNum(facts.monthly_bill_eur)}/month bill at ${BILL_PRICE_EUR_KWH} €/kWh.`);
  }
  if (annual == null && facts.household) {
    annual = HOUSEHOLD_KWH[facts.household] ?? HOUSEHOLD_KWH_5PLUS;
    assumptions.push(`Annual use estimated from household size (${facts.household} people): ${annual} kWh.`);
  }
  if (annual == null) {
    annual = DEFAULT_KWH;
    assumptions.push(`Annual use unknown: ${DEFAULT_KWH.toLocaleString("en-US")} kWh assumed.`);
  }

  const hasEv = facts.has_ev ?? (facts.ev_km_year != null && facts.ev_km_year > 0);
  // "Is there already PV on the roof?" The answer wins; a stated size implies yes; a size that contradicts it is dropped.
  const statedPv = facts.existing_pv_kwp;
  const hasExistingPv = facts.has_existing_pv ?? (statedPv != null && statedPv > 0 ? true : null);
  const existingPvKwp = hasExistingPv === false || (hasExistingPv && statedPv === 0) ? null : statedPv;
  const home: Home = {
    annual_kwh: annual,
    price_eur_kwh: null, // engine default
    // Engine presets exist for who is home only in one-person homes; other households keep H0 (answer stays in facts).
    load_profile: facts.household === 1 && facts.daytime_presence != null
      ? (facts.daytime_presence ? "HomeOfficeOnePerson" : "FullTimeOnePerson") : "H0",
    has_ev: hasEv,
    // An EV with no distance still needs a wallbox decision: 15,000 km/year, as in the planner form.
    ev_km_year: hasEv ? (facts.ev_km_year ?? EV_KM_DEFAULT) : null,
    has_existing_pv: hasExistingPv,
    existing_pv_kwp: existingPvKwp,
    existing_battery_kwh: facts.existing_battery_kwh,
    heating: facts.heating ? (HEATING[facts.heating] ?? null) : null,
    heating_demand_kwh: null,
    roof_type: facts.roof_type && ROOF_TYPES.includes(facts.roof_type) ? facts.roof_type : null,
    house_sqm: null,
    inhabitants: facts.household,
    orientation_deg: facts.roof_direction ? (ORIENTATION[facts.roof_direction] ?? null) : null,
    tilt_deg: null,
    demand_is_default: demandStated ? false : null,
  };
  if (hasEv && facts.ev_km_year == null) assumptions.push(`EV distance not given: ${EV_KM_DEFAULT.toLocaleString("en-US")} km/year assumed.`);
  return { facts, home, assumptions };
}

/** The caller's own answers that /live shows next to the engine Home (top level of calls.facts). */
function displayFacts(f: VoiceFacts) {
  return {
    customer_name: f.customer_name,
    household: f.household,
    monthly_bill_eur: f.monthly_bill_eur,
    roof_direction: f.roof_direction,
    heating_age_years: f.heating_age_years,
  };
}

/** Enough to size a system without inventing the household's use. */
export function hasUsageFacts(raw: Record<string, unknown>): boolean {
  return [raw.annual_kwh, raw.monthly_bill_eur].some((v) => (parsePositive(v) ?? 0) > 0) || parseHousehold(raw.household) != null;
}

// ---------------------------------------------------------------------------
// Phrasing the engine's design (no new numbers, only the engine's)
// ---------------------------------------------------------------------------
const heatpumpLater = (d: DesignResponse) =>
  !d.design.heatpump.include && Boolean(d.options?.heatpump?.available || d.design.heatpump.option?.available);

function joinList(parts: string[], and: string): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} ${and} ${parts[parts.length - 1]}`;
}

/** "10.8 kWp solar, a 10 kWh battery and a wallbox; a heat pump is a later option." */
export function spokenSummary(d: DesignResponse): string {
  const { pv, battery, wallbox, heatpump } = d.design;
  const parts: string[] = [];
  if (pv.include && pv.kwp) parts.push(`${fmtNum(pv.kwp)} kWp solar`);
  if (battery.include && battery.kwh) parts.push(`a ${fmtNum(battery.kwh)} kWh battery`);
  if (wallbox.include) parts.push("a wallbox");
  if (heatpump.include && heatpump.kw) parts.push(`a ${fmtNum(heatpump.kw)} kW heat pump`);
  if (!parts.length) return "no new system for now.";
  return `${joinList(parts, "and")}${heatpumpLater(d) ? "; a heat pump is a later option" : ""}.`;
}

export function toolInstruction(d: DesignResponse | null): { instruction: string } {
  return {
    instruction: d
      ? `Tell the caller: Your draft design is ready: ${spokenSummary(d)} It is in the planner's inbox now.`
      : "Tell the caller: Thank you, I have all the details. The draft design will be in the planner's inbox in a minute.",
  };
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
const sha = (s: string) => createHash("sha256").update(s).digest();

/** Constant-time check of the agent's shared secret. False when no secret is configured. */
export function checkAgentToken(header: string | null, secret: string | undefined): boolean {
  if (!secret || !header) return false;
  return timingSafeEqual(sha(header), sha(secret));
}

/** ElevenLabs webhook signature: header `t=<unix>,v0=<hex hmac-sha256(secret, "<t>.<raw body>")>`. */
export function verifyElevenLabsSignature(rawBody: string, header: string | null, secret: string | undefined, nowSec: number): boolean {
  if (!secret || !header) return false;
  const parts = header.split(",").map((p) => p.trim().split("=", 2) as [string, string]);
  const t = Number(parts.find(([k]) => k === "t")?.[1]);
  if (!Number.isFinite(t) || Math.abs(nowSec - t) > SIGNATURE_TOLERANCE_S) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  return parts.some(([k, v]) => k === "v0" && typeof v === "string" && v.length === expected.length &&
    timingSafeEqual(Buffer.from(v), Buffer.from(expected)));
}

// ---------------------------------------------------------------------------
// Storage (Supabase service role; a no-op store when Supabase is not configured)
// ---------------------------------------------------------------------------
export interface CallPatch {
  conversation_id: string | null;
  status?: string;
  customer_name?: string;
  address?: string;
  facts?: Record<string, unknown>; // shallow-merged into the stored facts
  /** The row as just read (skips the lookup round trip; its facts are the merge base). */
  existing?: StoredCall;
  transcript?: TranscriptTurn[];
  summary?: string | null;
}

export interface StoredCall {
  id: string;
  facts: Record<string, unknown>;
}

export interface VoiceStore {
  /** Insert, or update the row with the same conversation_id. Returns the call id, or null if not stored. */
  saveCall(p: CallPatch): Promise<string | null>;
  /** One voice draft per call: updates the call's existing draft (still status 'draft'), else inserts. Returns its id. */
  saveDesign(row: { call_id: string | null; home: Home; locks: Locks; design: DesignResponse }): Promise<string | null>;
  callHasDesign(callId: string): Promise<boolean>;
  getDesign(id: string): Promise<DesignResponse | null>;
  /** home + locks of a stored design row (for rows saved without an engine answer), or null. */
  getDesignInputs?(id: string): Promise<{ home: Home; locks: Locks } | null>;
  /** The stored call (id + facts) with this conversation_id, or null. */
  getCall(conversationId: string): Promise<StoredCall | null>;
}

const log = (msg: string) => console.info(`[voice] ${msg}`);

let warnedNoDb = false;
export const nullStore: VoiceStore = {
  async saveCall() {
    if (!warnedNoDb) log("supabase not configured: calls and designs are not stored");
    warnedNoDb = true;
    return null;
  },
  saveDesign: async () => null,
  callHasDesign: async () => false,
  getDesign: async () => null,
  getCall: async () => null,
};

/** Postgres/PostgREST "column does not exist" (migration 20261107_calls_conversation_id not applied yet). */
const missingColumn = (e: { code?: string } | null) => e?.code === "42703" || e?.code === "PGRST204";

export function supabaseStore(db: SupabaseClient): VoiceStore {
  async function saveCall(p: CallPatch, retried = false): Promise<string | null> {
    const fields = Object.fromEntries(
      Object.entries({ status: p.status, customer_name: p.customer_name, address: p.address, transcript: p.transcript, summary: p.summary })
        .filter(([, v]) => v !== undefined),
    );
    const facts = { ...(p.facts ?? {}), ...(p.conversation_id ? { conversation_id: p.conversation_id } : {}) };
    try {
      if (p.conversation_id) {
        const found = p.existing && !retried
          ? { data: p.existing }
          : await db.from("calls").select("id, facts").eq("conversation_id", p.conversation_id).maybeSingle();
        if (found.data) {
          const { error } = await db.from("calls").update({ ...fields, facts: { ...found.data.facts, ...facts } }).eq("id", found.data.id);
          if (error) log(`calls update failed: ${error.message}`);
          return found.data.id as string;
        }
      }
      const row = { ...fields, facts, conversation_id: p.conversation_id };
      let res = await db.from("calls").insert(row).select("id").single();
      if (missingColumn(res.error)) {
        log("calls.conversation_id missing: apply supabase/migrations/20261107_calls_conversation_id.sql");
        const { conversation_id: _omit, ...rest } = row;
        void _omit;
        res = await db.from("calls").insert(rest).select("id").single();
      }
      if (res.error?.code === "23505" && !retried) return saveCall(p, true); // raced with another write: update instead
      if (res.error) log(`calls insert failed: ${res.error.message}`);
      return (res.data?.id as string | undefined) ?? null;
    } catch (e) {
      log(`calls write failed: ${e instanceof Error ? e.message : "unknown error"}`);
      return null;
    }
  }

  return {
    saveCall: (p) => saveCall(p),
    async getCall(conversationId) {
      const { data, error } = await db.from("calls").select("id, facts").eq("conversation_id", conversationId).maybeSingle();
      if (error) log(`calls read failed: ${error.message}`);
      return data ? { id: data.id as string, facts: (data.facts as Record<string, unknown>) ?? {} } : null;
    },
    async saveDesign(row) {
      const save = async (retried: boolean): Promise<string | null> => {
        if (row.call_id) {
          const { data: existing } = await db
            .from("designs").select("id, status").eq("call_id", row.call_id).eq("source", "voice").limit(1).maybeSingle();
          if (existing) {
            if (existing.status !== "draft") {
              log("voice draft already picked up by a planner: not overwritten");
              return existing.id as string;
            }
            const { error } = await db.from("designs").update({ home: row.home, locks: row.locks, design: row.design }).eq("id", existing.id);
            if (error) log(`designs update failed: ${error.message}`);
            return existing.id as string;
          }
        }
        const { data, error } = await db
          .from("designs")
          .insert({ ...row, source: "voice", status: "draft", explanation: null })
          .select("id")
          .single();
        if (error?.code === "23505" && !retried) return save(true); // another path inserted it first: update that one
        if (error) log(`designs insert failed: ${error.message}`);
        return (data?.id as string | undefined) ?? null;
      };
      try {
        return await save(false);
      } catch (e) {
        log(`designs write failed: ${e instanceof Error ? e.message : "unknown error"}`);
        return null;
      }
    },
    async callHasDesign(callId) {
      const { data } = await db.from("designs").select("id").eq("call_id", callId).limit(1);
      return Boolean(data?.length);
    },
    async getDesign(id) {
      const { data } = await db.from("designs").select("design").eq("id", id).maybeSingle();
      return (data?.design as DesignResponse | null | undefined) ?? null;
    },
    async getDesignInputs(id) {
      const { data } = await db.from("designs").select("home, locks").eq("id", id).maybeSingle();
      return data?.home ? { home: data.home as Home, locks: { ...EMPTY_LOCKS, ...((data.locks as Partial<Locks> | null) ?? {}) } } : null;
    },
  };
}

// ---------------------------------------------------------------------------
// Dependencies (injected so the handlers are testable without Next, Supabase or the network)
// ---------------------------------------------------------------------------
export interface VoiceDeps {
  store: VoiceStore;
  design: (req: DesignRequest) => Promise<DesignResponse>;
  solar: (address: string) => Promise<SolarResult>;
  /** Run work after the response is sent (next/server `after`). */
  defer: (fn: () => Promise<void>) => void;
  installer: string;
  toolSecret?: string;
  webhookSecret?: string;
  anthropicKey?: string;
  elevenLabsKey?: string;
  voiceId?: string;
  ttsEnabled: boolean;
  /** Accept a client-sent design_response in /explain (dev only: in production only stored designs are explained). */
  allowInlineDesign: boolean;
  fetch: typeof fetch;
  now: () => number; // ms
  timing?: typeof LATE_TIMING;
}

export function voiceDeps(defer: VoiceDeps["defer"]): VoiceDeps {
  const db = getServerSupabase();
  const env = process.env;
  return {
    store: db ? supabaseStore(db) : nullStore,
    design: async (req) => {
      const r = await engine.design(req);
      // B's client answers with a rule-of-thumb "offline estimate" when the engine is down. A voice draft must come from
      // the engine, so treat that as "not ready" (pending + retry). Without ENGINE_URL at all (dev), the mock is accepted.
      if (r.served?.source === "offline" && engineUrl()) throw new Error(`engine offline (${r.served.reason})`);
      return r;
    },
    solar: (address) => lookupSolar(address),
    defer,
    installer: env.VOICE_INSTALLER || DEFAULT_INSTALLER,
    toolSecret: env.ELEVENLABS_TOOL_SECRET,
    webhookSecret: env.ELEVENLABS_WEBHOOK_SECRET,
    anthropicKey: env.ANTHROPIC_API_KEY,
    elevenLabsKey: env.ELEVENLABS_API_KEY,
    voiceId: env.ELEVENLABS_VOICE_ID,
    ttsEnabled: env.VOICE_TTS_ENABLED === "true",
    allowInlineDesign: env.NODE_ENV !== "production",
    fetch: (...args) => fetch(...args),
    now: () => Date.now(),
  };
}

/** Resolve to the value, or null on timeout / error (logged without details that could hold secrets). */
export async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      log(`${what} timed out after ${ms} ms`);
      resolve(null);
    }, ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } catch (e) {
    log(`${what} failed: ${e instanceof Error ? e.message : "unknown error"}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Drafting a design from call facts (create_design tool and post-call fallback)
// ---------------------------------------------------------------------------
export interface DraftResult {
  instruction: string;
  call_id: string | null;
  design_id: string | null;
  pending: boolean;
}

/** Google's roof fills the orientation and tilt the caller did not state (create_design and /intake alike). */
export function applyGoogleRoof(home: Home, solar: SolarResult | null, assumptions: string[]): void {
  const roof = solar ? roofFromSolar(solar) : null;
  if (roof && (home.orientation_deg == null || home.tilt_deg == null)) {
    if (home.orientation_deg == null) home.orientation_deg = roof.orientation_deg;
    if (home.tilt_deg == null) home.tilt_deg = roof.tilt_deg;
    assumptions.push(`Roof orientation ${home.orientation_deg}° and tilt ${home.tilt_deg}° from Google Solar (largest roof face where not stated).`);
  }
}

export async function createDraftFromFacts(
  raw: unknown,
  deps: VoiceDeps,
  opts: { budgetMs: number; callStatus: string; existing?: StoredCall; extraFacts?: Record<string, unknown> },
): Promise<DraftResult> {
  const t0 = deps.now();
  const { facts, home, assumptions } = normaliseFacts(raw);

  let solar: SolarResult | null = null;
  const storedSolar = opts.existing?.facts.solar_for === facts.address ? (opts.existing?.facts.solar as SolarResult | undefined) : undefined;
  if (facts.address) {
    solar = storedSolar // update_facts already looked this roof up
      ?? (await withTimeout(deps.solar(facts.address), Math.min(SOLAR_BUDGET_MS, opts.budgetMs * 0.36), "solar"));
    applyGoogleRoof(home, solar, assumptions);
  }

  const req: DesignRequest = { installer: deps.installer, home, locks: EMPTY_LOCKS };
  const left = Math.max(250, opts.budgetMs - (deps.now() - t0));
  const engineCall = deps.design(req);
  engineCall.catch(() => {}); // a late rejection is handled below; never unhandled
  // Store the call while the engine works (keeps the answer inside the ~3 s budget).
  const [design, callId] = await Promise.all([
    withTimeout(engineCall, left, "engine"),
    deps.store.saveCall({
      conversation_id: facts.conversation_id,
      status: opts.callStatus,
      customer_name: facts.customer_name ?? undefined,
      address: facts.address ?? undefined,
      facts: { ...home, ...displayFacts(facts), voice: facts, assumptions, solar, ...opts.extraFacts },
      existing: opts.existing,
    }),
  ]);

  if (design) {
    const designId = await deps.store.saveDesign({ call_id: callId, home, locks: EMPTY_LOCKS, design });
    return { ...toolInstruction(design), call_id: callId, design_id: designId, pending: false };
  }

  const timing = deps.timing ?? LATE_TIMING;
  deps.defer(async () => {
    let late = await withTimeout(engineCall, timing.lateMs, "engine (late answer)");
    if (!late) {
      await new Promise((r) => setTimeout(r, timing.retryAfterMs));
      late = await withTimeout(deps.design(req), timing.retryMs, "engine retry");
    }
    if (late) await deps.store.saveDesign({ call_id: callId, home, locks: EMPTY_LOCKS, design: late });
    else log("engine still unavailable: call stored without a design");
  });
  return { ...toolInstruction(null), call_id: callId, design_id: null, pending: true };
}

// ---------------------------------------------------------------------------
// POST /api/voice/create-design
// ---------------------------------------------------------------------------
const NO_FACTS = "No answers were sent. Ask the caller for their name, address and electricity use, then call create_design again with them.";
const SAY_SORRY = "Tell the caller: I could not save the design right now, a planner will follow up with you.";

export async function handleCreateDesign(req: Request, deps: VoiceDeps, opts = { budgetMs: CREATE_BUDGET_MS }): Promise<Response> {
  const t0 = deps.now();
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  if (!checkAgentToken(req.headers.get("x-agent-token") ?? bearer, deps.toolSecret)) {
    log("create-design rejected: bad or missing agent token");
    return Response.json({ instruction: SAY_SORRY }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ instruction: SAY_SORRY }, { status: 400 });
  }
  // Answers update_facts stored during the call fill whatever the agent did not repeat now. The read gets
  // up to STORED_READ_MS: from a US function region one Supabase (EU) round trip alone can take 300-400 ms.
  const cid = parseText((body as Record<string, unknown>).conversation_id);
  let existing: StoredCall | undefined;
  let extraFacts: Record<string, unknown> | undefined;
  if (cid) {
    existing = (await withTimeout(deps.store.getCall(cid), STORED_READ_MS, "stored facts")) ?? undefined;
    const merged = mergeStated(existing?.facts.stated as Record<string, unknown> | undefined, body as Record<string, unknown>);
    if (existing?.facts.stated) body = { ...merged.stated, conversation_id: cid };
    extraFacts = { stated: merged.stated };
  }
  // Nothing the caller said (an empty or malformed tool call): store nothing, so no empty "incoming call" reaches /live.
  const said = normaliseFacts(body).facts;
  if (!FACT_FIELDS.some((k) => said[k] != null)) {
    log("create-design rejected: no facts");
    return Response.json({ instruction: NO_FACTS }, { status: 400 });
  }
  const left = Math.max(250, opts.budgetMs - (deps.now() - t0));
  const result = await createDraftFromFacts(body, deps, { budgetMs: left, callStatus: "live", existing, extraFacts });
  log(`create-design ${deps.now() - t0} ms, design ${result.pending ? "pending" : (result.design_id ?? "not stored")}`);
  return Response.json(result);
}

// ---------------------------------------------------------------------------
// POST /api/voice/update-facts (agent server tool, called after each answer during the call)
// ---------------------------------------------------------------------------
/** The facts the agent may send (same names as create_design and the post-call data collection). */
export const FACT_FIELDS = [
  "customer_name", "address", "annual_kwh", "monthly_bill_eur", "household", "daytime_presence", "has_ev", "ev_km_year",
  "heating", "heating_age_years", "roof_type", "roof_direction", "has_existing_pv", "existing_pv_kwp", "existing_battery_kwh",
  "wishes", "notes",
] as const;

const meaningful = (v: unknown) =>
  v != null && (typeof v === "number" ? Number.isFinite(v) : typeof v === "boolean" || parseText(v) != null);

/** Newly stated answers over earlier ones. Empty / "unknown" never erases an answer; unknown keys are ignored. */
export function mergeStated(prev: Record<string, unknown> | undefined, next: Record<string, unknown>) {
  const stated: Record<string, unknown> = { ...(prev ?? {}) };
  const changed: string[] = [];
  for (const k of FACT_FIELDS) {
    const v = next[k];
    if (!meaningful(v)) continue;
    if (JSON.stringify(stated[k]) !== JSON.stringify(v)) changed.push(k);
    stated[k] = v;
  }
  return { stated, changed };
}

// One writer per conversation at a time (per server instance): answers arrive back to back.
const factQueues = new Map<string, Promise<unknown>>();
function serialised<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = factQueues.get(key) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  factQueues.set(key, run);
  void run.finally(() => {
    if (factQueues.get(key) === run) factQueues.delete(key);
  }).catch(() => {});
  return run;
}

export async function handleUpdateFacts(req: Request, deps: VoiceDeps): Promise<Response> {
  const t0 = deps.now();
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  if (!checkAgentToken(req.headers.get("x-agent-token") ?? bearer, deps.toolSecret)) {
    log("update-facts rejected: bad or missing agent token");
    return Response.json({ ok: false, error: "unauthorised" }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  const raw = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  const cid = raw ? parseText(raw.conversation_id) : null;
  if (!raw || !cid) return Response.json({ ok: false, error: "conversation_id is required" }, { status: 400 });

  const result = await serialised(cid, async () => {
    const call = await deps.store.getCall(cid);
    const prev = call?.facts ?? {};
    const { stated, changed } = mergeStated(prev.stated as Record<string, unknown> | undefined, raw);
    const { facts, home, assumptions } = normaliseFacts({ ...stated, conversation_id: cid });
    // Keep a roof found earlier for this address unless the caller stated the direction.
    const solar = prev.solar as SolarResult | undefined;
    const roof = solar ? roofFromSolar(solar) : null;
    const solarForAddress = Boolean(solar && prev.solar_for === facts.address);
    if (roof && solarForAddress) {
      if (home.orientation_deg == null) home.orientation_deg = roof.orientation_deg;
      if (home.tilt_deg == null) home.tilt_deg = roof.tilt_deg;
    }
    const callId = await deps.store.saveCall({
      conversation_id: cid,
      status: "live",
      customer_name: facts.customer_name ?? undefined,
      address: facts.address ?? undefined,
      facts: { ...home, ...displayFacts(facts), voice: facts, stated, assumptions, updated_fields: changed, facts_updated_at: new Date(deps.now()).toISOString() },
      existing: call ?? undefined,
    });
    if (facts.address && !solarForAddress) {
      const address = facts.address;
      deps.defer(async () => {
        const found = await withTimeout(deps.solar(address), 5000, "solar (update-facts)");
        if (!found) return;
        await serialised(cid, async () => {
          const row = await deps.store.getCall(cid);
          const now = row?.facts ?? {};
          if ((now.voice as VoiceFacts | undefined)?.address !== address) return; // address changed meanwhile
          const r = roofFromSolar(found);
          const v = now.voice as VoiceFacts;
          const patch: Record<string, unknown> = { solar: found, solar_for: address };
          if (r && v.roof_direction == null && now.orientation_deg == null) patch.orientation_deg = r.orientation_deg;
          if (r && now.tilt_deg == null) patch.tilt_deg = r.tilt_deg;
          await deps.store.saveCall({ conversation_id: cid, facts: patch, existing: row ?? undefined });
        });
      });
    }
    return { callId, changed };
  });
  log(`update-facts ${deps.now() - t0} ms, updated ${result.changed.join(", ") || "nothing new"}`);
  return Response.json({ ok: true, call_id: result.callId, updated: result.changed, ms: deps.now() - t0 });
}

// ---------------------------------------------------------------------------
// POST /api/voice/post-call (ElevenLabs post_call_transcription webhook)
// ---------------------------------------------------------------------------
interface ElTurn { role?: string; message?: string | null; time_in_call_secs?: number }

function mapTranscript(turns: unknown, startSec: number | undefined): TranscriptTurn[] {
  if (!Array.isArray(turns)) return [];
  return (turns as ElTurn[])
    .filter((t) => typeof t?.message === "string" && t.message.trim())
    .map((t) => ({
      role: t.role === "user" ? "customer" : (t.role ?? "agent"),
      text: t.message as string,
      ...(startSec != null ? { at: new Date((startSec + (t.time_in_call_secs ?? 0)) * 1000).toISOString() } : {}),
    }));
}

const valuesOf = (obj: unknown, key: string): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(obj && typeof obj === "object" ? (obj as Record<string, Record<string, unknown>>) : {})
      .map(([k, v]) => [k, v && typeof v === "object" ? v[key] : v]),
  );

export async function handlePostCall(req: Request, deps: VoiceDeps): Promise<Response> {
  const raw = await req.text(); // verify the RAW body before parsing
  if (!verifyElevenLabsSignature(raw, req.headers.get("elevenlabs-signature"), deps.webhookSecret, Math.floor(deps.now() / 1000))) {
    log("post-call rejected: bad signature");
    return Response.json({ error: "invalid signature" }, { status: 401 });
  }
  let body: { type?: string; data?: Record<string, unknown> };
  try {
    body = JSON.parse(raw);
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  if (body.type !== "post_call_transcription") return Response.json({ ignored: true });

  const data = body.data ?? {};
  const conversationId = parseText(data.conversation_id);
  if (!conversationId) return Response.json({ error: "conversation_id missing" }, { status: 400 });
  const analysis = (data.analysis ?? {}) as Record<string, unknown>;
  const collected = valuesOf(analysis.data_collection_results, "value");
  const status = data.status === "failed" ? "failed" : "ended";
  const startSec = parseNumber((data.metadata as Record<string, unknown> | undefined)?.start_time_unix_secs) ?? undefined;

  const callId = await deps.store.saveCall({
    conversation_id: conversationId,
    status,
    customer_name: parseText(collected.customer_name) ?? undefined,
    address: parseText(collected.address) ?? undefined,
    transcript: mapTranscript(data.transcript, startSec),
    summary: parseText(analysis.transcript_summary),
    facts: {
      post_call: {
        collected,
        evaluation: valuesOf(analysis.evaluation_criteria_results, "result"),
        call_successful: analysis.call_successful ?? null,
      },
    },
  });

  // The agent may have hung up before calling create_design: draft one from the collected facts.
  if (callId && hasUsageFacts(collected)) {
    deps.defer(async () => {
      if (await deps.store.callHasDesign(callId)) return;
      await createDraftFromFacts({ ...collected, conversation_id: conversationId }, deps, { budgetMs: POSTCALL_BUDGET_MS, callStatus: status });
    });
  }
  log(`post-call stored (${status})`);
  return Response.json({ ok: true, call_id: callId });
}

// ---------------------------------------------------------------------------
// POST /api/voice/explain — 45-second homeowner summary (+ audio only when enabled)
// ---------------------------------------------------------------------------
type Lang = "en" | "de";
const pct = (x: number | undefined) => Math.round((x ?? 0) * 100);

// ---------------------------------------------------------------------------
// The offer as a timeline: each sentence may belong to a moment of the house's day ("Listen to your offer"
// drives the 3D house's clock: morning 8 h, noon 12.5 h, evening 19 h).
// ---------------------------------------------------------------------------
export type Moment = "morning" | "noon" | "evening" | null;
export const MOMENT_HOUR: Record<Exclude<Moment, null>, number> = { morning: 8, noon: 12.5, evening: 19 };
export interface ScriptSegment {
  text: string;
  moment: Moment;
}
export interface TimedSegment extends ScriptSegment {
  start_s: number;
  end_s: number;
  /** clock time the house should show while this sentence plays; null = keep the current time */
  time_of_day_h: number | null;
}
const SCRIPT_VERSION = 2; // bump when the script/timing format changes (invalidates cached audio)

/** Deterministic script (fallback when Claude is not available), with a morning / noon / evening day story. ≤ 110 words. */
export function offerSegmentsTemplate(d: DesignResponse, lang: Lang): ScriptSegment[] {
  const e = d.economics;
  const autarky = pct(d.physics?.autarky);
  const { pv, battery, wallbox, heatpump } = d.design;
  const solar = pv.include && Boolean(pv.kwp);
  const bat = battery.include && Boolean(battery.kwh);
  const s = (text: string, moment: Moment = null): ScriptSegment | null => (text ? { text, moment } : null);
  if (lang === "de") {
    const n = (x: number) => x.toLocaleString("de-DE");
    const parts = [
      solar ? `${n(pv.kwp!)} kWp Photovoltaik` : "",
      bat ? `einen ${n(battery.kwh!)} kWh Speicher` : "",
      wallbox.include ? "eine Wallbox" : "",
      heatpump.include && heatpump.kw ? `eine ${n(heatpump.kw)} kW Wärmepumpe` : "",
    ].filter(Boolean);
    return [
      s(`Ihr Angebot in Kürze: Wir empfehlen ${parts.length ? joinList(parts, "und") : "vorerst keine neue Anlage"}.`),
      s(heatpumpLater(d) ? "Eine Wärmepumpe ist später möglich." : ""),
      s(solar ? "Am Morgen wachen die Module mit der Sonne auf und decken schon das Frühstück." : "", "morning"),
      s(solar ? `Mittags erzeugt das Dach mehr, als Sie brauchen${bat ? ", und der Speicher füllt sich" : ""}${wallbox.include ? ", das Auto lädt mit Sonnenstrom" : ""}.` : "", "noon"),
      s(solar ? (bat ? "Am Abend übernimmt der Speicher." : "Am Abend kommt der Strom wie gewohnt aus dem Netz.") : "", "evening"),
      s(autarky > 0 ? `So decken Sie etwa ${autarky} % Ihres Stroms selbst.` : ""),
      s(e ? `Die Anlage kostet etwa ${n(e.capex_total_eur)} € und spart im ersten Jahr etwa ${n(e.savings_first_year_eur)} €` +
        (e.payback_years ? `; sie hat sich nach etwa ${n(e.payback_years)} Jahren bezahlt gemacht.` : ".") : ""),
      s("Ihr Installateur bespricht jedes Detail mit Ihnen."),
    ].filter((x): x is ScriptSegment => x !== null);
  }
  const n = (x: number) => x.toLocaleString("en-US");
  return [
    s(`Here is your offer in short. We suggest ${spokenSummary(d)}`),
    s(solar ? "In the morning, the panels wake up with the sun and already cover breakfast." : "", "morning"),
    s(solar ? `At midday the roof makes more than you need${bat ? ", so the battery fills up" : ""}${wallbox.include ? " and the car charges on sunshine" : ""}.` : "", "noon"),
    s(solar ? (bat ? "In the evening, the battery takes over." : "In the evening, you use grid power as before.") : "", "evening"),
    s(autarky > 0 ? `Altogether you cover about ${autarky}% of your electricity yourself.` : ""),
    s(e ? `The system costs about €${n(e.capex_total_eur)} and saves about €${n(e.savings_first_year_eur)} in the first year` +
      (e.payback_years ? `, so it pays for itself in about ${n(e.payback_years)} years.` : ".") : ""),
    s("Your installer will go through every detail with you."),
  ].filter((x): x is ScriptSegment => x !== null);
}

/** The template as one text. */
export function offerTemplate(d: DesignResponse, lang: Lang): string {
  return offerSegmentsTemplate(d, lang).map((x) => x.text).join(" ");
}

/** Only engine numbers go to Claude; it phrases them, it never sizes anything. */
function offerFacts(d: DesignResponse) {
  const { pv, battery, wallbox, heatpump } = d.design;
  const clean = (r: string) => r.replace(/^\[mock\]\s*/, "");
  return {
    pv_kwp: pv.include ? pv.kwp : null,
    battery_kwh: battery.include ? battery.kwh : null,
    wallbox: wallbox.include,
    heatpump_kw: heatpump.include ? heatpump.kw : null,
    heatpump_possible_later: heatpumpLater(d),
    yearly_solar_yield_kwh: d.physics?.yield_kwh ?? null,
    share_of_own_power_used_pct: pct(d.physics?.self_consumption),
    share_of_needs_covered_pct: pct(d.physics?.autarky),
    investment_eur: d.economics?.capex_total_eur ?? null,
    first_year_savings_eur: d.economics?.savings_first_year_eur ?? null,
    payback_years: d.economics?.payback_years ?? null,
    reasons: [...pv.reasons, ...battery.reasons, ...wallbox.reasons].map(clean).slice(0, 4),
  };
}

/** Every number Claude writes must be one of the engine's (any rounding / separator style). */
export function numbersAllowed(text: string, facts: ReturnType<typeof offerFacts>): boolean {
  return unknownNumbers(text, facts).length === 0;
}

function unknownNumbers(text: string, facts: ReturnType<typeof offerFacts>): string[] {
  const ok = new Set<number>();
  for (const v of Object.values(facts)) {
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    [v, Math.round(v), Math.round(v * 10) / 10, Math.round(v / 100) * 100, Math.round(v / 1000) * 1000].forEach((x) => ok.add(x));
  }
  const found = text.match(/\d[\d.,]*/g) ?? [];
  return found.filter((raw) => {
    const t = raw.replace(/[.,]$/, "");
    const asThousands = /^\d{1,3}([.,]\d{3})+$/.test(t) ? Number(t.replace(/[.,]/g, "")) : NaN;
    const asDecimal = Number(t.replace(",", "."));
    return !(ok.has(asThousands) || ok.has(asDecimal));
  });
}

/** Spoken text only: no markdown emphasis, headings, bullets or voice tags (TTS would read them, the UI would show them). */
export function plainSpoken(t: string): string {
  return t
    .replace(/\*\*|__|`/g, "")
    .replace(/(^|\s)[*_](\S[^*_]*\S|\S)[*_](?=\s|[.,!?;:]|$)/g, "$1$2")
    .replace(/^\s*(#{1,6}\s+|[-*•]\s+)/gm, "")
    .replace(/\[[^\]\n]{1,40}\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Claude's JSON script → segments, or null if it is not usable (then the template is used). */
export function parseScript(raw: string, d: DesignResponse): ScriptSegment[] | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(m[0]);
  } catch {
    return null;
  }
  const list = (parsed as { segments?: unknown })?.segments;
  if (!Array.isArray(list) || !list.length) return null;
  const segments: ScriptSegment[] = [];
  for (const x of list) {
    const text = typeof x?.text === "string" ? plainSpoken(x.text) : "";
    const mo = x?.moment;
    const moment: Moment = mo === "morning" || mo === "noon" || mo === "evening" ? mo : null;
    if (text) segments.push({ text, moment });
  }
  const all = segments.map((x) => x.text).join(" ");
  const words = all.split(/\s+/).length;
  const hasDay = ["morning", "noon", "evening"].every((mo) => segments.some((x) => x.moment === mo));
  const problem = words > 130 ? `${words} words` : d.design.pv.include && !hasDay ? "no morning/noon/evening"
    : !numbersAllowed(all, offerFacts(d)) ? `numbers not from the engine: ${unknownNumbers(all, offerFacts(d)).join(", ")}` : null;
  if (problem) {
    log(`Claude script rejected: ${problem}`);
    return null;
  }
  return segments;
}

export async function offerScript(d: DesignResponse, lang: Lang, deps: VoiceDeps): Promise<{ segments: ScriptSegment[]; by: "claude" | "template" }> {
  const template = { segments: offerSegmentsTemplate(d, lang), by: "template" as const };
  if (!deps.anthropicKey) return template;
  try {
    const res = await deps.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(15000),
      headers: { "content-type": "application/json", "x-api-key": deps.anthropicKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: EXPLAIN_MODEL,
        max_tokens: 900,
        thinking: { type: "between_tools" }, // = no thinking before the answer (thinking ate the whole budget; "disabled" is rejected by this model)
        system:
          "You write a short spoken summary of a home energy offer for the homeowner, to be read aloud while a 3D model " +
          "of their house plays through one sunny day. Plain everyday words, warm and factual, no jargon, no markdown. " +
          "At most 110 words in total (about 45 seconds). Use ONLY the numbers in the facts; never invent or change a size, " +
          "price or saving, and write no other numbers (no clock times). Leave out anything missing. " +
          "Structure: 5 to 7 sentences. Exactly one sentence each for the morning, midday and evening, saying what the " +
          "system does for this household at that time (solar, battery, car), in that order, after the opening sentence. " +
          "End by saying the installer will go through the details. " +
          `Write in ${lang === "de" ? "German (Sie-Form)" : "English"}. ` +
          'Answer with JSON only: {"segments":[{"text":"…","moment":"none|morning|noon|evening"}]}',
        messages: [{ role: "user", content: `Offer facts (from the design engine):\n${JSON.stringify(offerFacts(d), null, 2)}` }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}`);
    const json = await res.json();
    const raw = (json?.content ?? []).filter((c: { type?: string }) => c?.type === "text").map((c: { text: string }) => c.text).join("").trim();
    const segments = parseScript(raw, d);
    if (!segments) throw new Error(raw ? "script not usable (format, length or numbers)" : `no text (stop_reason ${json?.stop_reason ?? "?"})`);
    return { segments, by: "claude" };
  } catch (e) {
    log(`explain via Claude failed, using template: ${e instanceof Error ? e.message : "unknown error"}`);
    return template;
  }
}

export interface Alignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}
const CHARS_PER_SECOND = 14.5; // ElevenLabs narration pace, for estimates without audio
const GAP_S = 0.3;
const r2 = (x: number) => Math.round(x * 100) / 100;

/** Start/end of every sentence: from the TTS character alignment when there is audio, else estimated. */
export function timeSegments(segments: ScriptSegment[], alignment: Alignment | null): { segments: TimedSegment[]; duration_s: number } {
  const hour = (m: Moment) => (m ? MOMENT_HOUR[m] : null);
  const total = segments.reduce((n, x) => n + x.text.length, 0) + Math.max(0, segments.length - 1);
  const starts = alignment?.character_start_times_seconds ?? [];
  const ends = alignment?.character_end_times_seconds ?? [];
  const usable = alignment && starts.length > 0 && ends.length === starts.length;
  const at = (i: number, arr: number[]) => arr[Math.min(arr.length - 1, Math.round((i * (arr.length - 1)) / Math.max(1, total - 1)))];
  let offset = 0;
  let clock = 0;
  const timed = segments.map((x) => {
    const first = offset;
    const last = offset + x.text.length - 1;
    offset += x.text.length + 1;
    let start_s: number;
    let end_s: number;
    if (usable) {
      const exact = starts.length === total;
      start_s = exact ? starts[first] : at(first, starts);
      end_s = exact ? ends[last] : at(last, ends);
    } else {
      start_s = clock;
      end_s = clock + x.text.length / CHARS_PER_SECOND;
      clock = end_s + GAP_S;
    }
    return { ...x, start_s: r2(start_s), end_s: r2(end_s), time_of_day_h: hour(x.moment) };
  });
  const duration_s = usable ? r2(ends[ends.length - 1]) : r2(Math.max(0, clock - GAP_S));
  return { segments: timed, duration_s };
}

/** ElevenLabs TTS with character timestamps → mp3 (base64) + alignment. */
export async function speak(text: string, deps: VoiceDeps): Promise<{ audio_base64: string; alignment: Alignment | null }> {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(deps.voiceId ?? "")}/with-timestamps?output_format=mp3_44100_128`;
  const res = await deps.fetch(url, {
    method: "POST",
    signal: AbortSignal.timeout(45000),
    headers: { "content-type": "application/json", "xi-api-key": deps.elevenLabsKey ?? "" },
    body: JSON.stringify({ text, model_id: "eleven_multilingual_v2" }),
  });
  if (!res.ok) throw new Error(`ElevenLabs TTS ${res.status}`);
  const json = (await res.json()) as { audio_base64?: string; alignment?: Alignment | null };
  if (!json.audio_base64) throw new Error("ElevenLabs TTS: no audio in the answer");
  return { audio_base64: json.audio_base64, alignment: json.alignment ?? null };
}

// ---------------------------------------------------------------------------
// Cache: same engine facts + language + voice → same script and audio. Memory per server instance, plus clips
// committed under public/voice/ (listed in voice-cache.json) so the demo offer never calls ElevenLabs again.
// ---------------------------------------------------------------------------
interface CachedExplain {
  text: string;
  by: "claude" | "template";
  language: Lang;
  segments: TimedSegment[];
  duration_s: number;
  timing: "audio" | "estimated";
  audio_base64: string | null;
  audio_url?: string;
}
const explainCache = new Map<string, CachedExplain>();
export function clearExplainCache() {
  explainCache.clear();
  explainInFlight.clear();
}
type StaticClip = Omit<CachedExplain, "audio_base64" | "audio_url"> & { audio_path: string };
let staticClips: Record<string, StaticClip> = staticVoiceCache as Record<string, StaticClip>;
/** Tests only: replace the committed clip list. */
export function setStaticClips(c: Record<string, StaticClip>) {
  staticClips = c;
}

export function explainKey(d: DesignResponse, lang: Lang, voiceId: string | undefined): string {
  return createHash("sha256").update(JSON.stringify({ v: SCRIPT_VERSION, lang, voice: voiceId ?? "", facts: offerFacts(d) })).digest("hex").slice(0, 16);
}

export async function handleExplain(req: Request, deps: VoiceDeps): Promise<Response> {
  // Public endpoint that spends Anthropic (and ElevenLabs) credit: limit per client.
  if (!allowRequest("explain", clientKey(req), 10, 60_000)) return Response.json({ error: "too many requests" }, { status: 429 });
  let body: { design_id?: unknown; design_response?: DesignResponse; language?: unknown; audio?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  const designId = parseText(body?.design_id);
  // Only stored (engine-made) designs in production, so nobody can make the offer voice read arbitrary text.
  const inline = deps.allowInlineDesign ? body?.design_response : undefined;
  let d = inline ?? (designId ? await deps.store.getDesign(designId) : null);
  if (!d && designId) {
    // A row saved without an engine answer (e.g. seeded or planner-made): design it now, like the offer page does.
    const inputs = await deps.store.getDesignInputs?.(designId);
    if (inputs) {
      try {
        d = await deps.design({ installer: deps.installer, home: inputs.home, locks: inputs.locks });
      } catch (e) {
        log(`explain: engine design for stored inputs failed: ${e instanceof Error ? e.message : "unknown error"}`);
      }
    }
  }
  if (!d && designId) return Response.json({ error: "design not found" }, { status: 404 });
  if (!d?.design?.pv) return Response.json({ error: "design_id is required" }, { status: 400 });

  const lang: Lang = body.language === "de" ? "de" : "en";
  const wantAudio = body.audio === true;
  let audio_reason: string | undefined;
  if (!wantAudio) audio_reason = "not_requested";
  else if (!deps.ttsEnabled) audio_reason = "tts_disabled"; // no audio until Mark confirms the voice
  else if (!deps.elevenLabsKey || !deps.voiceId) audio_reason = "tts_not_configured";
  const canSpeak = wantAudio && !audio_reason;
  const key = explainKey(d, lang, deps.voiceId);
  const reply = (c: CachedExplain, cached: string | null, reason = audio_reason) =>
    Response.json({
      ...c,
      audio_base64: wantAudio ? c.audio_base64 : null,
      ...(wantAudio ? {} : { audio_url: undefined }),
      cache_key: key,
      cached,
      ...(reason ? { audio_reason: reason } : {}),
    });

  // 1. A committed clip (the demo offer): no Claude, no ElevenLabs.
  const clip = staticClips[key];
  if (clip) {
    const { audio_path, ...rest } = clip;
    let audio_base64: string | null = null;
    if (wantAudio) {
      try {
        const r = await deps.fetch(new URL(audio_path, req.url));
        // Only real audio: a gate or error page must never be played (or passed off) as the clip.
        if (r.ok && (r.headers.get("content-type") ?? "").startsWith("audio/")) audio_base64 = Buffer.from(await r.arrayBuffer()).toString("base64");
        else log(`cached clip not served as audio (${r.status} ${r.headers.get("content-type") ?? "no type"})`);
      } catch (e) {
        log(`cached clip unreadable: ${e instanceof Error ? e.message : "unknown error"}`);
      }
    }
    return reply({ ...rest, audio_base64, audio_url: audio_path }, "clip", wantAudio && !audio_base64 ? "clip_unavailable" : undefined);
  }

  // 2. This instance already made it (with audio if audio is wanted).
  const hit = explainCache.get(key);
  if (hit && (hit.audio_base64 || !canSpeak)) return reply(hit, "memory");

  // 3. Make it once: concurrent requests for the same design (the offer page's prefetch, a click, a second tab)
  //    share one Claude + ElevenLabs run instead of paying for it twice.
  const flightKey = `${key}:${canSpeak ? "audio" : "text"}`;
  let flight = explainInFlight.get(flightKey);
  const shared = Boolean(flight);
  if (!flight) {
    flight = makeExplain(d, lang, canSpeak, hit, deps).finally(() => explainInFlight.delete(flightKey));
    explainInFlight.set(flightKey, flight);
  }
  const made = await flight;
  if (canSpeak && !made.audio_base64) audio_reason = "error";
  return reply(made, shared ? "in_flight" : null);
}

const explainInFlight = new Map<string, Promise<CachedExplain>>();

/** Script (Claude or template), then audio with timestamps; stores the result in this instance's cache. */
async function makeExplain(d: DesignResponse, lang: Lang, canSpeak: boolean, hit: CachedExplain | undefined, deps: VoiceDeps): Promise<CachedExplain> {
  const key = explainKey(d, lang, deps.voiceId);
  const script = hit ? { segments: hit.segments.map(({ text, moment }) => ({ text, moment })), by: hit.by } : await offerScript(d, lang, deps);
  const text = script.segments.map((x) => x.text).join(" ");
  let audio_base64: string | null = null;
  let alignment: Alignment | null = null;
  if (canSpeak) {
    try {
      ({ audio_base64, alignment } = await speak(text, deps));
    } catch (e) {
      log(`tts failed: ${e instanceof Error ? e.message : "unknown error"}`);
    }
  }
  const { segments, duration_s } = timeSegments(script.segments, audio_base64 ? alignment : null);
  const made: CachedExplain = {
    text, by: script.by, language: lang, segments, duration_s,
    timing: audio_base64 && alignment ? "audio" : "estimated", audio_base64,
  };
  if (explainCache.size >= 50) explainCache.delete(explainCache.keys().next().value as string);
  explainCache.set(key, made);
  return made;
}
