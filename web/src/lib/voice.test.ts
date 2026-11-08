import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { engine } from "./engine";
import { mockDesign } from "./engine-mock";
import { EMPTY_LOCKS, type DesignRequest, type DesignResponse } from "./types";
import { clearSolarCache, type SolarResult } from "./solar";
import {
  checkAgentToken,
  handleCreateDesign,
  handleExplain,
  handlePostCall,
  normaliseFacts,
  parseHousehold,
  offerTemplate,
  spokenSummary,
  toolInstruction,
  verifyElevenLabsSignature,
  type CallPatch,
  type VoiceDeps,
  type VoiceStore,
  voiceDeps,
  handleUpdateFacts,
  supabaseStore,
  clearExplainCache,
  explainKey,
  numbersAllowed,
  offerSegmentsTemplate,
  parseScript,
  plainSpoken,
  setStaticClips,
  timeSegments,
} from "./voice";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const design = (home: Partial<DesignRequest["home"]> = {}, locks = EMPTY_LOCKS): DesignResponse =>
  mockDesign({
    installer: "installer_a",
    locks,
    home: {
      annual_kwh: 4500, price_eur_kwh: null, load_profile: "H0", has_ev: false, ev_km_year: null, existing_pv_kwp: null,
      existing_battery_kwh: null, heating: null, heating_demand_kwh: null, roof_type: null, house_sqm: null, inhabitants: null,
      ...home,
    },
  });

function withHpOption(d: DesignResponse): DesignResponse {
  return { ...d, design: { ...d.design, heatpump: { ...d.design.heatpump, option: { available: true, kw: 9, reasons: [] } } } };
}

function fakeStore() {
  const calls = new Map<string, { id: string; patch: CallPatch }>();
  const designs: { id: string; call_id: string | null; design: DesignResponse }[] = [];
  let n = 0;
  const store: VoiceStore = {
    async saveCall(p) {
      const existing = p.conversation_id ? [...calls.values()].find((c) => c.patch.conversation_id === p.conversation_id) : undefined;
      if (existing) {
        const defined = Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined));
        existing.patch = { ...existing.patch, ...defined, facts: { ...existing.patch.facts, ...p.facts } };
        return existing.id;
      }
      const id = `call-${++n}`;
      calls.set(id, { id, patch: p });
      return id;
    },
    async saveDesign(row) {
      const existing = row.call_id ? designs.find((d) => d.call_id === row.call_id) : undefined;
      if (existing) {
        existing.design = row.design;
        return existing.id;
      }
      const id = `design-${++n}`;
      designs.push({ id, call_id: row.call_id, design: row.design });
      return id;
    },
    async callHasDesign(callId) {
      return designs.some((d) => d.call_id === callId);
    },
    async getDesign(id) {
      return designs.find((d) => d.id === id)?.design ?? null;
    },
    async getCall(conversationId) {
      await new Promise((r) => setTimeout(r, 1)); // a real round trip: lets concurrent writers interleave
      const c = [...calls.values()].find((x) => x.patch.conversation_id === conversationId);
      return c ? { id: c.id, facts: { ...c.patch.facts } } : null;
    },
  };
  return { store, calls, designs };
}

function deps(over: Partial<VoiceDeps> = {}): VoiceDeps & { deferred: (() => Promise<void>)[] } {
  const deferred: (() => Promise<void>)[] = [];
  return {
    store: fakeStore().store,
    design: async (req) => mockDesign(req),
    solar: async (): Promise<SolarResult> => ({ status: "no_key", reason: "test" }),
    defer: (fn) => void deferred.push(fn),
    installer: "installer_a",
    toolSecret: "tool-secret",
    webhookSecret: "wh-secret",
    anthropicKey: "",
    elevenLabsKey: "",
    voiceId: "",
    ttsEnabled: false,
    allowInlineDesign: true,
    fetch: vi.fn() as unknown as typeof fetch,
    now: () => Date.now(),
    timing: { lateMs: 20, retryAfterMs: 10, retryMs: 50 },
    ...over,
    deferred,
  };
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://x${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

beforeEach(() => clearSolarCache()); // also resets the rate-limit windows

// ---------------------------------------------------------------------------
// normaliseFacts
// ---------------------------------------------------------------------------
describe("normaliseFacts", () => {
  it("turns a monthly bill into annual kWh at 0.35 €/kWh and says so", () => {
    const r = normaliseFacts({ monthly_bill_eur: 120 });
    expect(r.home.annual_kwh).toBe(4100);
    expect(r.assumptions[0]).toBe("Annual use estimated from a €120/month bill at 0.35 €/kWh.");
  });
  it("parses German thousands and spoken numbers", () => {
    expect(normaliseFacts({ annual_kwh: "4.500" }).home.annual_kwh).toBe(4500);
    expect(normaliseFacts({ annual_kwh: "about 3200 kWh" }).home.annual_kwh).toBe(3200);
    expect(normaliseFacts({ existing_pv_kwp: "4,5" }).home.existing_pv_kwp).toBe(4.5);
  });
  it("estimates use from household size when nothing else is known", () => {
    const r = normaliseFacts({ household: 4 });
    expect(r.home.annual_kwh).toBe(4250);
    expect(r.home.inhabitants).toBe(4);
    expect(r.assumptions).toHaveLength(1);
  });
  it("falls back to 4000 kWh with an assumption when nothing is known", () => {
    const r = normaliseFacts({});
    expect(r.home.annual_kwh).toBe(4000);
    expect(r.assumptions).toHaveLength(1);
  });
  it("maps heating and roof direction to engine values", () => {
    const r = normaliseFacts({ heating: "gas", roof_direction: "south_west", annual_kwh: 4000 });
    expect(r.home.heating).toBe("Gas");
    expect(r.home.orientation_deg).toBe(225);
    expect(normaliseFacts({ heating: "heatpump" }).home.heating).toBe("Heatpump");
    expect(normaliseFacts({ roof_direction: "east_west" }).home.orientation_deg).toBe(90); // both faces 90° off south
    expect(normaliseFacts({ roof_direction: "unknown" }).home.orientation_deg).toBeNull();
  });
  it("never sends NaN: empty, unknown and junk become null", () => {
    const r = normaliseFacts({ annual_kwh: "", ev_km_year: "unknown", existing_pv_kwp: "none", heating_age_years: null, household: "n/a" });
    expect(r.home.annual_kwh).toBe(4000);
    expect(r.home.ev_km_year).toBeNull();
    expect(r.home.existing_pv_kwp).toBeNull();
    expect(r.home.inhabitants).toBeNull();
    expect(JSON.stringify(r)).not.toContain("NaN");
  });
  it("maps has_existing_pv yes/no/unknown together with existing_pv_kwp", () => {
    expect(normaliseFacts({ has_existing_pv: "yes", existing_pv_kwp: "6,5" }).home).toMatchObject({ has_existing_pv: true, existing_pv_kwp: 6.5 });
    expect(normaliseFacts({ has_existing_pv: "no" }).home).toMatchObject({ has_existing_pv: false, existing_pv_kwp: null });
    expect(normaliseFacts({ has_existing_pv: "unknown" }).home.has_existing_pv).toBeNull();
    expect(normaliseFacts({}).home.has_existing_pv).toBeNull();
    // a stated size implies PV on the roof; "yes" with size 0 keeps "yes" and drops the contradictory 0
    expect(normaliseFacts({ existing_pv_kwp: 4 }).home.has_existing_pv).toBe(true);
    expect(normaliseFacts({ has_existing_pv: "yes", existing_pv_kwp: 0 }).home).toMatchObject({ has_existing_pv: true, existing_pv_kwp: null });
    // "no" wins over a stray size
    expect(normaliseFacts({ has_existing_pv: false, existing_pv_kwp: 5 }).home).toMatchObject({ has_existing_pv: false, existing_pv_kwp: null });
  });

  it("parses household words and digits (EN + DE) into a number", () => {
    const cases: [unknown, number | null][] = [
      ["single", 1], ["alone", 1], ["1 person", 1], ["allein", 1],
      ["couple", 2], ["two of us", 2], ["zu zweit", 2],
      ["family of four", 4], ["vier Personen", 4], ["4 people", 4], [4, 4], ["4", 4],
      ["5+", 5], ["couple with two kids", 4], ["single parent with one child", 2],
      ["zu dritt", 3], ["50", 20], ["unknown", null], ["", null], [0, null],
    ];
    for (const [input, want] of cases) expect([input, parseHousehold(input)]).toEqual([input, want]);
    expect(normaliseFacts({ household: "family of four" }).home).toMatchObject({ inhabitants: 4, annual_kwh: 4250 });
  });

  it("maps daytime presence to an engine preset only for one-person homes", () => {
    expect(normaliseFacts({ household: "single", daytime_presence: true }).home.load_profile).toBe("HomeOfficeOnePerson");
    expect(normaliseFacts({ household: 1, daytime_presence: "no" }).home.load_profile).toBe("FullTimeOnePerson");
    expect(normaliseFacts({ household: 1, daytime_presence: "works from home" }).home.load_profile).toBe("HomeOfficeOnePerson");
    expect(normaliseFacts({ household: 4, daytime_presence: true }).home.load_profile).toBe("H0");
    expect(normaliseFacts({ daytime_presence: true }).home.load_profile).toBe("H0");
    expect(normaliseFacts({ household: 1 }).home.load_profile).toBe("H0");
    expect(normaliseFacts({ household: 4, daytime_presence: true }).facts.daytime_presence).toBe(true);
  });

  it("defaults ev_km_year to 15000 when the caller has an EV but gave no distance", () => {
    const n = normaliseFacts({ has_ev: "yes", household: 3 });
    expect(n.home).toMatchObject({ has_ev: true, ev_km_year: 15000 });
    expect(n.assumptions.join(" ")).toContain("15,000 km/year assumed");
    expect(normaliseFacts({ has_ev: "yes", ev_km_year: "8.000" }).home.ev_km_year).toBe(8000);
    expect(normaliseFacts({ has_ev: "no" }).home).toMatchObject({ has_ev: false, ev_km_year: null });
    expect(normaliseFacts({ has_ev: "no" }).assumptions.join(" ")).not.toContain("km/year");
  });

  it("marks demand as real (demand_is_default=false) only when use or bill was stated", () => {
    expect(normaliseFacts({ annual_kwh: 4500 }).home.demand_is_default).toBe(false);
    expect(normaliseFacts({ monthly_bill_eur: 120 }).home.demand_is_default).toBe(false);
    expect(normaliseFacts({ household: 4 }).home.demand_is_default).toBeNull();
    expect(normaliseFacts({}).home.demand_is_default).toBeNull();
  });

  it("post-call fallback draft carries has_existing_pv to the engine", async () => {
    let seen: DesignRequest | null = null;
    const d = deps({ design: async (req) => ((seen = req), mockDesign(req)), now: () => NOW * 1000 });
    const body = postCallBody("conv_pv", { annual_kwh: 4000, has_existing_pv: "yes", existing_pv_kwp: 5 });
    await handlePostCall(post("/api/voice/post-call", body, { "elevenlabs-signature": sign(body, "wh-secret", NOW) }), d);
    await Promise.all(d.deferred.map((fn) => fn()));
    expect(seen!.home).toMatchObject({ has_existing_pv: true, existing_pv_kwp: 5 });
  });

  it("post-call fallback draft uses a household given only in words", async () => {
    let seen: DesignRequest | null = null;
    const d = deps({ design: async (req) => ((seen = req), mockDesign(req)), now: () => NOW * 1000 });
    const body = postCallBody("conv_hh", { household: "family of four", daytime_presence: true });
    await handlePostCall(post("/api/voice/post-call", body, { "elevenlabs-signature": sign(body, "wh-secret", NOW) }), d);
    await Promise.all(d.deferred.map((fn) => fn()));
    expect(seen!.home).toMatchObject({ inhabitants: 4, annual_kwh: 4250, load_profile: "H0" });
  });

  it("counts a planned EV as yes, but not a planned existing PV", () => {
    expect(normaliseFacts({ has_ev: "planned" }).home).toMatchObject({ has_ev: true, ev_km_year: 15000 });
    expect(normaliseFacts({ has_ev: "Next year" }).home.has_ev).toBe(true);
    expect(normaliseFacts({ has_existing_pv: "planned" }).home.has_existing_pv).toBeNull();
  });

  it("reads EV answers", () => {
    expect(normaliseFacts({ has_ev: "yes", ev_km_year: "15000" }).home).toMatchObject({ has_ev: true, ev_km_year: 15000 });
    expect(normaliseFacts({ has_ev: false, ev_km_year: 15000 }).home).toMatchObject({ has_ev: false, ev_km_year: null });
  });
});

// ---------------------------------------------------------------------------
// spoken summary
// ---------------------------------------------------------------------------
describe("spokenSummary / toolInstruction", () => {
  it("PV + battery + wallbox + heat pump option", () => {
    const d = withHpOption(design({ annual_kwh: 5000, has_ev: true, ev_km_year: 15000 }, { ...EMPTY_LOCKS, pv_kwp: 10.8, battery_kwh: 10 }));
    expect(spokenSummary(d)).toBe("10.8 kWp solar, a 10 kWh battery and a wallbox; a heat pump is a later option.");
  });
  it("leaves out what is not included", () => {
    const d = design({}, { ...EMPTY_LOCKS, pv_kwp: 4.5, battery_kwh: 0 });
    expect(spokenSummary(d)).toBe("4.5 kWp solar.");
  });
  it("names an included heat pump", () => {
    const d = design({}, { ...EMPTY_LOCKS, pv_kwp: 9, battery_kwh: 10, wallbox: false, heatpump_kw: 9 });
    expect(spokenSummary(d)).toBe("9 kWp solar, a 10 kWh battery and a 9 kW heat pump.");
  });
  it("instruction with and without a design", () => {
    const d = design({}, { ...EMPTY_LOCKS, pv_kwp: 4.5, battery_kwh: 0 });
    expect(toolInstruction(d).instruction).toBe(
      "Tell the caller: Your draft design is ready: 4.5 kWp solar. It is in the planner's inbox now.",
    );
    expect(toolInstruction(null).instruction).toBe(
      "Tell the caller: Thank you, I have all the details. The draft design will be in the planner's inbox in a minute.",
    );
  });
});

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------
describe("checkAgentToken", () => {
  it("accepts only the exact secret, and nothing when unset", () => {
    expect(checkAgentToken("s3cret", "s3cret")).toBe(true);
    expect(checkAgentToken("s3cre", "s3cret")).toBe(false);
    expect(checkAgentToken(null, "s3cret")).toBe(false);
    expect(checkAgentToken("", "")).toBe(false);
    expect(checkAgentToken("x", undefined)).toBe(false);
  });
});

const sign = (body: string, secret: string, t: number) =>
  `t=${t},v0=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;

describe("verifyElevenLabsSignature", () => {
  const now = 1_800_000_000;
  it("accepts a fresh valid signature", () => {
    expect(verifyElevenLabsSignature("{}", sign("{}", "k", now), "k", now)).toBe(true);
  });
  it("rejects tampered body, wrong secret, stale or missing header", () => {
    expect(verifyElevenLabsSignature('{"a":1}', sign("{}", "k", now), "k", now)).toBe(false);
    expect(verifyElevenLabsSignature("{}", sign("{}", "other", now), "k", now)).toBe(false);
    expect(verifyElevenLabsSignature("{}", sign("{}", "k", now - 31 * 60), "k", now)).toBe(false);
    expect(verifyElevenLabsSignature("{}", null, "k", now)).toBe(false);
    expect(verifyElevenLabsSignature("{}", sign("{}", "k", now), undefined, now)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// POST /api/voice/create-design
// ---------------------------------------------------------------------------
const FACTS = {
  conversation_id: "conv_1",
  customer_name: "Anna Weber",
  address: "Musterstraße 1, München",
  monthly_bill_eur: 150,
  household: 4,
  has_ev: "yes",
  ev_km_year: 15000,
  heating: "gas",
  roof_direction: "south",
};

describe("supabaseStore.saveCall", () => {
  function fakeDb(row: { id: string; facts: Record<string, unknown> } | null) {
    const ops: string[] = [];
    let updated: Record<string, unknown> | null = null;
    const builder = (table: string) => {
      const b = {
        select: () => (ops.push(`select ${table}`), b),
        eq: () => b,
        maybeSingle: async () => ({ data: row, error: null }),
        update: (v: Record<string, unknown>) => ((updated = v), ops.push(`update ${table}`), b),
        insert: () => (ops.push(`insert ${table}`), b),
        single: async () => ({ data: { id: "new" }, error: null }),
        then: (res: (v: { error: null }) => void) => res({ error: null }),
      };
      return b;
    };
    return { db: { from: builder } as unknown as Parameters<typeof supabaseStore>[0], ops, updated: () => updated };
  }

  it("with the row already read: one update, merged onto those facts, no second lookup", async () => {
    const f = fakeDb({ id: "c-1", facts: { a: 1 } });
    const id = await supabaseStore(f.db).saveCall({ conversation_id: "conv", status: "live", facts: { b: 2 }, existing: { id: "c-1", facts: { a: 1, keep: true } } });
    expect(id).toBe("c-1");
    expect(f.ops).toEqual(["update calls"]);
    expect(f.updated()).toMatchObject({ status: "live", facts: { a: 1, keep: true, b: 2, conversation_id: "conv" } });
  });

  it("without it: looks the row up first", async () => {
    const f = fakeDb({ id: "c-1", facts: { a: 1 } });
    await supabaseStore(f.db).saveCall({ conversation_id: "conv", facts: { b: 2 } });
    expect(f.ops).toEqual(["select calls", "update calls"]);
    expect(f.updated()).toMatchObject({ facts: { a: 1, b: 2 } });
  });
});

describe("handleUpdateFacts", () => {
  const auth = { "x-agent-token": "tool-secret" };
  const upd = (d: ReturnType<typeof deps>, body: unknown, headers: Record<string, string> = auth) =>
    handleUpdateFacts(post("/api/voice/update-facts", body, headers), d);
  const stored = (store: ReturnType<typeof fakeStore>, cid = "c1") =>
    [...store.calls.values()].find((c) => c.patch.conversation_id === cid)?.patch;

  it("rejects a missing token (401) and a missing conversation_id (400)", async () => {
    const d = deps();
    expect((await upd(d, { conversation_id: "c1", household: 4 }, {})).status).toBe(401);
    expect((await upd(d, { household: 4 })).status).toBe(400);
    expect((await upd(d, "not json")).status).toBe(400);
  });

  it("stores each answer as it comes, merges partial facts, and is idempotent", async () => {
    const fs = fakeStore();
    const d = deps({ store: fs.store });
    const r1 = await upd(d, { conversation_id: "c1", household: "family of four" });
    expect(await r1.json()).toMatchObject({ ok: true, call_id: "call-1", updated: ["household"] });
    expect(stored(fs)).toMatchObject({ status: "live", facts: { inhabitants: 4, annual_kwh: 4250, stated: { household: "family of four" } } });

    // /live reads the caller's own answers at the top level of calls.facts
    await upd(d, { conversation_id: "c1", monthly_bill_eur: "120", roof_direction: "south west", customer_name: "Anna Test" });
    expect(stored(fs)?.facts).toMatchObject({ household: 4, monthly_bill_eur: 120, roof_direction: "south_west", customer_name: "Anna Test", annual_kwh: 4100 });
    const r2 = await upd(d, { conversation_id: "c1", has_ev: "yes" });
    expect((await r2.json()).updated).toEqual(["has_ev"]);
    expect(stored(fs)?.facts).toMatchObject({ inhabitants: 4, has_ev: true, ev_km_year: 15000 });

    const before = JSON.stringify({ ...stored(fs)?.facts, facts_updated_at: null, updated_fields: null });
    const r3 = await upd(d, { conversation_id: "c1", has_ev: "yes", household: "family of four" });
    expect((await r3.json()).updated).toEqual([]);
    expect(JSON.stringify({ ...stored(fs)?.facts, facts_updated_at: null, updated_fields: null })).toBe(before);
    expect(fs.calls.size).toBe(1);
  });

  it("empty or unknown answers never erase an earlier one; a correction overwrites it", async () => {
    const fs = fakeStore();
    const d = deps({ store: fs.store });
    await upd(d, { conversation_id: "c1", household: 4, customer_name: "Anna Test" });
    await upd(d, { conversation_id: "c1", household: "", customer_name: "unknown", roof_direction: null });
    expect(stored(fs)).toMatchObject({ customer_name: "Anna Test", facts: { inhabitants: 4 } });
    await upd(d, { conversation_id: "c1", household: 3 });
    expect(stored(fs)?.facts).toMatchObject({ inhabitants: 3 });
  });

  it("ignores fields that are not facts", async () => {
    const fs = fakeStore();
    const d = deps({ store: fs.store });
    const r = await upd(d, { conversation_id: "c1", annual_kwh: 5000, design: { pv: 99 }, status: "sent" });
    expect((await r.json()).updated).toEqual(["annual_kwh"]);
    expect(stored(fs)?.status).toBe("live");
    expect((stored(fs)?.facts as Record<string, unknown>).stated).toEqual({ annual_kwh: 5000 });
  });

  it("serialises concurrent answers for one call so none is lost", async () => {
    const fs = fakeStore();
    const d = deps({ store: fs.store });
    await Promise.all([
      upd(d, { conversation_id: "c1", household: 2 }),
      upd(d, { conversation_id: "c1", has_ev: "yes" }),
      upd(d, { conversation_id: "c1", roof_direction: "south" }),
    ]);
    expect((stored(fs)?.facts as Record<string, unknown>).stated).toEqual({ household: 2, has_ev: "yes", roof_direction: "south" });
  });

  it("looks the roof up from a new address after answering, and keeps it on later answers", async () => {
    const fs = fakeStore();
    const solar = vi.fn(async (): Promise<SolarResult> => ({
      status: "ok", address: "Musterstr 1", lat: 48.1, lng: 11.5, max_panels: 30, panel_watts: 400, sunshine_hours_year: 1100,
      imagery_quality: "HIGH", imagery_date: null,
      segments: [{ pitch_deg: 35, azimuth_deg: 170, area_m2: 50 }, { pitch_deg: 35, azimuth_deg: 350, area_m2: 50 }],
    }));
    const d = deps({ store: fs.store, solar });
    await upd(d, { conversation_id: "c1", address: "Musterstr 1, München" });
    expect(solar).not.toHaveBeenCalled(); // not on the answer path
    await Promise.all(d.deferred.map((fn) => fn()));
    expect(solar).toHaveBeenCalledTimes(1);
    expect(stored(fs)?.facts).toMatchObject({ orientation_deg: 170, tilt_deg: 35, solar: { status: "ok" } });
    await upd(d, { conversation_id: "c1", household: 2 });
    expect(stored(fs)?.facts).toMatchObject({ orientation_deg: 170, tilt_deg: 35, inhabitants: 2 });
    await Promise.all(d.deferred.slice(1).map((fn) => fn()));
    expect(solar).toHaveBeenCalledTimes(1); // same address: no second lookup
    let seen: DesignRequest | null = null;
    const res = await handleCreateDesign(
      post("/api/voice/create-design", { conversation_id: "c1", annual_kwh: 4000 }, auth),
      { ...d, design: async (req) => ((seen = req), mockDesign(req)) },
    );
    expect(res.status).toBe(200);
    expect(solar).toHaveBeenCalledTimes(1); // create-design reuses the stored roof
    expect(seen!.home).toMatchObject({ orientation_deg: 170, tilt_deg: 35 });
    expect(stored(fs)?.facts).toMatchObject({ orientation_deg: 170, solar: { status: "ok" } });
  });

  it("create-design still uses stored answers when the read takes a transatlantic 500 ms", async () => {
    const fs = fakeStore();
    let seen: DesignRequest | null = null;
    const d = deps({ store: fs.store, design: async (req) => ((seen = req), mockDesign(req)) });
    await upd(d, { conversation_id: "c1", household: 4, has_ev: "planned" });
    const slow = { ...fs.store, getCall: async (cid: string) => (await new Promise((r) => setTimeout(r, 500)), fs.store.getCall(cid)) };
    const res = await handleCreateDesign(post("/api/voice/create-design", { conversation_id: "c1", annual_kwh: 5200 }, auth), { ...d, store: slow });
    expect(res.status).toBe(200);
    expect(seen!.home).toMatchObject({ annual_kwh: 5200, inhabitants: 4, has_ev: true });
    expect(stored(fs)?.facts).toMatchObject({ inhabitants: 4, has_ev: true, stated: { household: 4, has_ev: "planned", annual_kwh: 5200 } });
  });

  it("create-design fills in answers the agent stored earlier but did not repeat", async () => {
    const fs = fakeStore();
    let seen: DesignRequest | null = null;
    const d = deps({ store: fs.store, design: async (req) => ((seen = req), mockDesign(req)) });
    await upd(d, { conversation_id: "c1", household: 4, has_ev: "yes", has_existing_pv: "no" });
    const res = await handleCreateDesign(post("/api/voice/create-design", { conversation_id: "c1", annual_kwh: 5000 }, auth), d);
    expect(res.status).toBe(200);
    expect(seen!.home).toMatchObject({ annual_kwh: 5000, inhabitants: 4, has_ev: true, has_existing_pv: false });
    expect(fs.calls.size).toBe(1);
  });
});

describe("handleCreateDesign", () => {
  it("401 with an instruction when the token is wrong or missing", async () => {
    const d = deps();
    const res = await handleCreateDesign(post("/api/voice/create-design", FACTS, { "x-agent-token": "nope" }), d);
    expect(res.status).toBe(401);
    expect((await res.json()).instruction).toMatch(/^Tell the caller:/);
    expect((await handleCreateDesign(post("/api/voice/create-design", FACTS), d)).status).toBe(401);
  });

  it("an empty call (no facts at all) stores nothing: no empty incoming call on /live", async () => {
    const s = fakeStore();
    const d = deps({ store: s.store });
    for (const body of [{}, { conversation_id: "conv_x" }, { customer_name: "", household: "unknown" }]) {
      const res = await handleCreateDesign(post("/api/voice/create-design", body, { "x-agent-token": "tool-secret" }), d);
      expect(res.status).toBe(400);
      expect((await res.json()).instruction).toMatch(/Ask the caller/);
    }
    expect(s.calls.size).toBe(0);
    expect(s.designs).toHaveLength(0);
  });

  it("drafts a design, writes calls + designs rows and returns the spoken summary", async () => {
    const s = fakeStore();
    const d = deps({ store: s.store });
    const res = await handleCreateDesign(post("/api/voice/create-design", FACTS, { "x-agent-token": "tool-secret" }), d);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.instruction).toMatch(/^Tell the caller: Your draft design is ready: [\d.]+ kWp solar/);
    expect(body.instruction).toContain("wallbox");
    expect(body.call_id).toBe("call-1");
    expect(body.design_id).toBe("design-2");
    const call = s.calls.get("call-1")!.patch;
    expect(call).toMatchObject({ conversation_id: "conv_1", status: "live", customer_name: "Anna Weber" });
    expect(call.facts).toMatchObject({ annual_kwh: 5100, has_ev: true, heating: "Gas", orientation_deg: 180 });
    expect(s.designs[0].call_id).toBe("call-1");
  });

  it("uses Google Solar to fill an unknown roof direction", async () => {
    let seen: DesignRequest | null = null;
    const d = deps({
      solar: async () => ({
        status: "ok", address: "a", lat: 1, lng: 2, max_panels: 30, panel_watts: 400, sunshine_hours_year: 1100,
        imagery_quality: "HIGH", imagery_date: null,
        segments: [{ pitch_deg: 35.4, azimuth_deg: 224.6, area_m2: 50 }],
      }),
      design: async (req) => ((seen = req), mockDesign(req)),
    });
    await handleCreateDesign(post("/api/voice/create-design", { ...FACTS, roof_direction: "unknown" }, { "x-agent-token": "tool-secret" }), d);
    expect(seen!.home).toMatchObject({ orientation_deg: 225, tilt_deg: 35 });
  });

  it("answers within budget when the engine hangs, and finishes the design afterwards", async () => {
    const s = fakeStore();
    let calls = 0;
    const d = deps({
      store: s.store,
      design: (req) => (++calls === 1 ? new Promise<DesignResponse>(() => {}) : Promise.resolve(mockDesign(req))),
    });
    const t0 = Date.now();
    const res = await handleCreateDesign(post("/api/voice/create-design", FACTS, { "x-agent-token": "tool-secret" }), d, { budgetMs: 200 });
    expect(Date.now() - t0).toBeLessThan(1000);
    const body = await res.json();
    expect(body.instruction).toContain("in a minute");
    expect(body.pending).toBe(true);
    expect(s.designs).toHaveLength(0);
    await Promise.all(d.deferred.map((fn) => fn()));
    expect(s.designs).toHaveLength(1);
    expect(s.designs[0].call_id).toBe("call-1");
  });

  it("still answers when nothing can be stored", async () => {
    const d = deps({
      store: { ...fakeStore().store, saveCall: async () => null, saveDesign: async () => null },
    });
    const res = await handleCreateDesign(post("/api/voice/create-design", FACTS, { "x-agent-token": "tool-secret" }), d);
    expect(res.status).toBe(200);
    expect((await res.json()).instruction).toContain("kWp solar");
  });

  it("keeps one voice draft per call when the agent calls the tool twice", async () => {
    const s = fakeStore();
    const d = deps({ store: s.store });
    const h = { "x-agent-token": "tool-secret" };
    await handleCreateDesign(post("/api/voice/create-design", FACTS, h), d);
    const res = await handleCreateDesign(post("/api/voice/create-design", { ...FACTS, monthly_bill_eur: 250 }, h), d);
    expect(s.designs).toHaveLength(1);
    expect((await res.json()).design_id).toBe(s.designs[0].id);
    expect(s.designs[0].design.design.pv.kwp).toBeGreaterThan(8); // the corrected (larger) use won
  });

  it("uses the slow engine's late answer without a second engine call", async () => {
    const LATE_MS = 500;
    const s = fakeStore();
    let calls = 0;
    const d = deps({
      store: s.store,
      design: (req) => (++calls, new Promise((r) => setTimeout(() => r(mockDesign(req)), 400))),
      timing: { lateMs: LATE_MS, retryAfterMs: 10, retryMs: 500 },
    });
    await handleCreateDesign(post("/api/voice/create-design", FACTS, { "x-agent-token": "tool-secret" }), d, { budgetMs: 50 });
    expect(s.designs).toHaveLength(0);
    await Promise.all(d.deferred.map((fn) => fn()));
    expect(calls).toBe(1);
    expect(s.designs).toHaveLength(1);
  });

  it("400 with an instruction on a broken body", async () => {
    const res = await handleCreateDesign(post("/api/voice/create-design", "{oops", { "x-agent-token": "tool-secret" }), deps());
    expect(res.status).toBe(400);
    expect((await res.json()).instruction).toMatch(/^Tell the caller:/);
  });
});

// ---------------------------------------------------------------------------
// POST /api/voice/post-call
// ---------------------------------------------------------------------------
const NOW = 1_800_000_000;
const postCallBody = (conversation_id: string, collected: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "post_call_transcription",
    event_timestamp: NOW,
    data: {
      agent_id: "agent_x",
      conversation_id,
      status: "done",
      transcript: [
        { role: "agent", message: "Hello!", time_in_call_secs: 0 },
        { role: "user", message: "Hi, Anna here.", time_in_call_secs: 3 },
      ],
      metadata: { start_time_unix_secs: NOW - 300 },
      analysis: {
        transcript_summary: "Anna wants solar for a family of four.",
        call_successful: "success",
        evaluation_criteria_results: { facts_complete: { criteria_id: "facts_complete", result: "success", rationale: "ok" } },
        data_collection_results: Object.fromEntries(
          Object.entries(collected).map(([k, v]) => [k, { data_collection_id: k, value: v, rationale: "said so" }]),
        ),
      },
    },
  });

describe("handlePostCall", () => {
  const signed = (body: string, t = NOW) => post("/api/voice/post-call", body, { "elevenlabs-signature": sign(body, "wh-secret", t) });

  it("stores transcript, summary and collected facts on the existing call", async () => {
    const s = fakeStore();
    const d = deps({ store: s.store, now: () => NOW * 1000 });
    await handleCreateDesign(post("/api/voice/create-design", FACTS, { "x-agent-token": "tool-secret" }), d);
    const res = await handlePostCall(signed(postCallBody("conv_1", { customer_name: "Anna Weber", household: 4 })), d);
    expect(res.status).toBe(200);
    const call = s.calls.get("call-1")!.patch;
    expect(call.status).toBe("ended");
    expect(call.summary).toBe("Anna wants solar for a family of four.");
    expect(call.transcript).toEqual([
      { role: "agent", text: "Hello!", at: new Date((NOW - 300) * 1000).toISOString() },
      { role: "customer", text: "Hi, Anna here.", at: new Date((NOW - 297) * 1000).toISOString() },
    ]);
    expect(call.facts).toMatchObject({ annual_kwh: 5100, post_call: { collected: { household: 4 }, evaluation: { facts_complete: "success" } } });
    await Promise.all(d.deferred.map((fn) => fn()));
    expect(s.designs).toHaveLength(1); // no second design: create_design already made one
  });

  it("rejects a tampered body or a stale signature and writes nothing", async () => {
    const s = fakeStore();
    const d = deps({ store: s.store, now: () => NOW * 1000 });
    const body = postCallBody("conv_2");
    const tampered = post("/api/voice/post-call", body.replace("Anna", "Eve"), { "elevenlabs-signature": sign(body, "wh-secret", NOW) });
    expect((await handlePostCall(tampered, d)).status).toBe(401);
    expect((await handlePostCall(signed(body, NOW - 31 * 60), d)).status).toBe(401);
    expect(s.calls.size).toBe(0);
  });

  it("creates the call and a draft design when the agent never called create_design", async () => {
    const s = fakeStore();
    const d = deps({ store: s.store, now: () => NOW * 1000 });
    const res = await handlePostCall(signed(postCallBody("conv_3", { customer_name: "Ben", annual_kwh: 3800, has_ev: false })), d);
    expect(res.status).toBe(200);
    expect(s.calls.size).toBe(1);
    await Promise.all(d.deferred.map((fn) => fn()));
    expect(s.designs).toHaveLength(1);
    const call = [...s.calls.values()][0].patch;
    expect(call).toMatchObject({ customer_name: "Ben", status: "ended" });
  });

  it("does not draft a design without any usage facts", async () => {
    const s = fakeStore();
    const d = deps({ store: s.store, now: () => NOW * 1000 });
    await handlePostCall(signed(postCallBody("conv_4", { customer_name: "Cleo" })), d);
    await Promise.all(d.deferred.map((fn) => fn()));
    expect(s.designs).toHaveLength(0);
  });

  it("ignores other webhook types", async () => {
    const body = JSON.stringify({ type: "post_call_audio", data: {} });
    const res = await handlePostCall(signed(body), deps({ now: () => NOW * 1000 }));
    expect(await res.json()).toEqual({ ignored: true });
  });
});

// ---------------------------------------------------------------------------
// POST /api/voice/explain
// ---------------------------------------------------------------------------
describe("offer timeline", () => {
  const withBattery = design({ annual_kwh: 5000, has_ev: true, ev_km_year: 15000 }, { ...EMPTY_LOCKS, pv_kwp: 10.8, battery_kwh: 10 });
  const noBattery = design({ annual_kwh: 3000 }, { ...EMPTY_LOCKS, pv_kwp: 6, battery_kwh: 0 });

  it("template tells the day in order: morning, noon, evening; battery or grid in the evening", () => {
    const a = offerSegmentsTemplate(withBattery, "en");
    expect(a.filter((x) => x.moment).map((x) => x.moment)).toEqual(["morning", "noon", "evening"]);
    expect(a.find((x) => x.moment === "evening")!.text).toContain("battery");
    expect(offerSegmentsTemplate(noBattery, "en").find((x) => x.moment === "evening")!.text).toContain("grid");
    expect(offerSegmentsTemplate(withBattery, "de").filter((x) => x.moment).length).toBe(3);
    for (const d of [withBattery, noBattery]) expect(offerSegmentsTemplate(d, "en").map((x) => x.text).join(" ").split(/\s+/).length).toBeLessThanOrEqual(110);
  });

  it("estimates timings without audio: in order, no overlap, clock hours 8 / 12.5 / 19", () => {
    const { segments, duration_s } = timeSegments(offerSegmentsTemplate(withBattery, "en"), null);
    for (let i = 1; i < segments.length; i++) expect(segments[i].start_s).toBeGreaterThan(segments[i - 1].end_s);
    expect(segments.map((x) => x.time_of_day_h).filter((h) => h != null)).toEqual([8, 12.5, 19]);
    expect(duration_s).toBe(segments[segments.length - 1].end_s);
    expect(duration_s).toBeGreaterThan(20);
    expect(duration_s).toBeLessThan(60);
  });

  it("scales the alignment when its length differs from the text", () => {
    const segs = [{ text: "aaaa", moment: "morning" as const }, { text: "bbbb", moment: "evening" as const }];
    const al = { characters: [], character_start_times_seconds: Array.from({ length: 18 }, (_, i) => i / 2), character_end_times_seconds: Array.from({ length: 18 }, (_, i) => (i + 1) / 2) };
    const { segments, duration_s } = timeSegments(segs, al);
    expect(segments[0].start_s).toBe(0);
    expect(segments[1].end_s).toBe(9);
    expect(duration_s).toBe(9);
    expect(segments[1].start_s).toBeGreaterThan(segments[0].end_s);
  });

  it("rejects a Claude script with invented numbers, no day story, or bad JSON", () => {
    const ok = JSON.stringify({ segments: [
      { text: "We suggest 10.8 kWp and a 10 kWh battery.", moment: "none" },
      { text: "Morning sun.", moment: "morning" }, { text: "Noon surplus.", moment: "noon" }, { text: "Evening battery.", moment: "evening" },
    ] });
    expect(parseScript(ok, withBattery)?.length).toBe(4);
    expect(parseScript(ok.replace("10.8 kWp", "12 kWp"), withBattery)).toBeNull();
    expect(parseScript(ok.replace('"noon"', '"none"'), withBattery)).toBeNull();
    expect(parseScript("Sure! Here you go: not json", withBattery)).toBeNull();
    expect(parseScript("```json\n" + ok + "\n```", withBattery)?.length).toBe(4);
  });

  it("speaks plain text: markdown and voice tags never reach TTS or the screen", () => {
    expect(plainSpoken("**What you get:** a *bright* roof [excited] and __more__.")).toBe("What you get: a bright roof and more.");
    expect(plainSpoken("## Heading\n- point one")).toBe("Heading point one");
    const md = JSON.stringify({ segments: [
      { text: "**We suggest** 10.8 kWp.", moment: "none" }, { text: "Morning sun.", moment: "morning" },
      { text: "Noon surplus.", moment: "noon" }, { text: "Evening *battery*.", moment: "evening" },
    ] });
    const d = design({ annual_kwh: 5000 }, { ...EMPTY_LOCKS, pv_kwp: 10.8, battery_kwh: 10 });
    expect(parseScript(md, d)!.map((x) => x.text)).toEqual(["We suggest 10.8 kWp.", "Morning sun.", "Noon surplus.", "Evening battery."]);
  });

  it("allows the engine's numbers in any rounding or separator style", () => {
    const facts = { pv_kwp: 10.8, battery_kwh: 10, wallbox: true, heatpump_kw: null, heatpump_possible_later: false, yearly_solar_yield_kwh: 10234,
      share_of_own_power_used_pct: 41, share_of_needs_covered_pct: 69, investment_eur: 23950, first_year_savings_eur: 1890, payback_years: 12.4, reasons: [] };
    expect(numbersAllowed("10.8 kWp, 10,8 kWp, €23,950 or 24,000 euros, 1.890 €, 69% and 12 years", facts)).toBe(true);
    expect(numbersAllowed("about 25,000 euros", facts)).toBe(false);
  });
});

describe("committed voice clips (voice-cache.json)", () => {
  it("every clip has its mp3 in public/ and timings in order", async () => {
    const { existsSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const clips = (await import("./voice-cache.json")).default as Record<string, { audio_path: string; segments: { start_s: number; end_s: number }[]; duration_s: number }>;
    for (const [key, c] of Object.entries(clips)) {
      expect(key).toMatch(/^[0-9a-f]{16}$/);
      const file = join(process.cwd(), "public", c.audio_path);
      expect(existsSync(file)).toBe(true);
      expect(statSync(file).size).toBeGreaterThan(10_000);
      for (let i = 1; i < c.segments.length; i++) expect(c.segments[i].start_s).toBeGreaterThanOrEqual(c.segments[i - 1].end_s);
      expect(c.segments[c.segments.length - 1].end_s).toBeLessThanOrEqual(c.duration_s);
    }
  });
});

describe("handleExplain", () => {
  const d0 = design({ annual_kwh: 5000 }, { ...EMPTY_LOCKS, pv_kwp: 10.8, battery_kwh: 10 });
  beforeEach(() => {
    clearExplainCache();
    setStaticClips({});
  });

  it("uses the template without an Anthropic key and keeps it under ~45 s", async () => {
    const res = await handleExplain(post("/api/voice/explain", { design_response: d0 }), deps());
    const body = await res.json();
    expect(body.by).toBe("template");
    expect(body.text).toContain("10.8 kWp");
    expect(body.text.split(/\s+/).length).toBeLessThanOrEqual(110);
    expect(body.audio_base64).toBeNull();
    expect(body.audio_reason).toBe("not_requested");
  });

  it("never calls ElevenLabs while TTS is disabled", async () => {
    const f = vi.fn();
    const res = await handleExplain(
      post("/api/voice/explain", { design_response: d0, audio: true }),
      deps({ fetch: f as unknown as typeof fetch, elevenLabsKey: "el", voiceId: "v", ttsEnabled: false }),
    );
    const body = await res.json();
    expect(body.audio_reason).toBe("tts_disabled");
    expect(f).not.toHaveBeenCalled();
  });

  const claudeScript = {
    segments: [
      { text: "Your roof can carry 10.8 kWp.", moment: "none" },
      { text: "Mornings start on sunshine.", moment: "morning" },
      { text: "At noon the battery fills.", moment: "noon" },
      { text: "Evenings run from the battery.", moment: "evening" },
      { text: "Your installer will go through the details.", moment: "none" },
    ],
  };

  it("passes Claude's script through as timed segments", async () => {
    const f = vi.fn(async () => Response.json({ content: [{ type: "text", text: JSON.stringify(claudeScript) }] }));
    const res = await handleExplain(
      post("/api/voice/explain", { design_response: d0 }),
      deps({ fetch: f as unknown as typeof fetch, anthropicKey: "ak" }),
    );
    const body = await res.json();
    expect(body).toMatchObject({ by: "claude", timing: "estimated" });
    expect(body.text).toBe(claudeScript.segments.map((x) => x.text).join(" "));
    expect(body.segments.map((x: { time_of_day_h: number | null }) => x.time_of_day_h)).toEqual([null, 8, 12.5, 19, null]);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(JSON.parse(String(init.body))).toMatchObject({ model: "claude-sonnet-5-5", thinking: { type: "between_tools" } });
  });

  /** ElevenLabs /with-timestamps answer for `text`: 10 characters per second. */
  const tts = (text: string) => ({
    audio_base64: "AQID",
    alignment: {
      characters: [...text],
      character_start_times_seconds: [...text].map((_, i) => i / 10),
      character_end_times_seconds: [...text].map((_, i) => (i + 1) / 10),
    },
  });

  it("returns audio with sentence timings from the TTS timestamps, and caches it", async () => {
    const f = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => Response.json(tts(JSON.parse(String(init?.body)).text)));
    const d = deps({ fetch: f as unknown as typeof fetch, elevenLabsKey: "el", voiceId: "voice1", ttsEnabled: true });
    const body = await (await handleExplain(post("/api/voice/explain", { design_response: d0, audio: true }), d)).json();
    expect(body).toMatchObject({ audio_base64: "AQID", timing: "audio", cached: null });
    expect(String((f.mock.calls[0] as unknown as [string])[0])).toContain("/v1/text-to-speech/voice1/with-timestamps");
    const segs = body.segments as { text: string; start_s: number; end_s: number; time_of_day_h: number | null }[];
    expect(segs[0].start_s).toBe(0);
    expect(segs[0].end_s).toBe(segs[0].text.length / 10);
    expect(segs[1].start_s).toBe((segs[0].text.length + 1) / 10);
    expect(segs.map((x) => x.time_of_day_h).filter((h) => h != null)).toEqual([8, 12.5, 19]);
    expect(body.duration_s).toBe(body.text.length / 10);
    const again = await (await handleExplain(post("/api/voice/explain", { design_response: d0, audio: true }), d)).json();
    expect(again).toMatchObject({ audio_base64: "AQID", cached: "memory" });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("shares one TTS run between concurrent requests for the same design (offer prefetch + click)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const f = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
      await gate;
      return Response.json(tts(JSON.parse(String(init?.body)).text));
    });
    const d = deps({ fetch: f as unknown as typeof fetch, elevenLabsKey: "el", voiceId: "voice1", ttsEnabled: true });
    const ask = () => handleExplain(post("/api/voice/explain", { design_response: d0, audio: true }), d).then((r) => r.json());
    const first = ask();
    const second = ask();
    await new Promise((r) => setTimeout(r, 0));
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(f).toHaveBeenCalledTimes(1);
    expect(a).toMatchObject({ audio_base64: "AQID", cached: null });
    expect(b).toMatchObject({ audio_base64: "AQID", cached: "in_flight", segments: a.segments });
    // a text-only request does not wait for (or receive) the audio run
    const text = await (await handleExplain(post("/api/voice/explain", { design_response: d0 }), d)).json();
    expect(text).toMatchObject({ audio_base64: null, cached: "memory" });
  });

  it("a failed TTS run is not cached as final: the next request pays again", async () => {
    let n = 0;
    const f = vi.fn(async (_u: string | URL | Request, init?: RequestInit) =>
      ++n === 1 ? new Response("busy", { status: 503 }) : Response.json(tts(JSON.parse(String(init?.body)).text)),
    );
    const d = deps({ fetch: f as unknown as typeof fetch, elevenLabsKey: "el", voiceId: "voice1", ttsEnabled: true });
    const ask = () => handleExplain(post("/api/voice/explain", { design_response: d0, audio: true }), d).then((r) => r.json());
    expect(await ask()).toMatchObject({ audio_base64: null, audio_reason: "error", timing: "estimated" });
    expect(await ask()).toMatchObject({ audio_base64: "AQID", timing: "audio" });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("never passes a login or error page off as the cached clip, and does not pay for a new one", async () => {
    const key = explainKey(d0, "en", "voice1");
    setStaticClips({
      [key]: { text: "Hi.", by: "claude", language: "en", segments: [{ text: "Hi.", moment: null, start_s: 0, end_s: 0.5, time_of_day_h: null }], duration_s: 0.5, timing: "audio", audio_path: "/voice/demo.mp3" },
    });
    const f = vi.fn(async () => new Response("<!DOCTYPE html><html>login</html>", { headers: { "content-type": "text/html" } }));
    const d = deps({ fetch: f as unknown as typeof fetch, elevenLabsKey: "el", voiceId: "voice1", ttsEnabled: true, anthropicKey: "ak" });
    const body = await (await handleExplain(post("/api/voice/explain", { design_response: d0, audio: true }), d)).json();
    expect(body).toMatchObject({ text: "Hi.", cached: "clip", audio_base64: null, audio_reason: "clip_unavailable" });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("serves a committed clip without calling Claude or ElevenLabs", async () => {
    const key = explainKey(d0, "en", "voice1");
    setStaticClips({
      [key]: { text: "Hi.", by: "claude", language: "en", segments: [{ text: "Hi.", moment: null, start_s: 0, end_s: 0.5, time_of_day_h: null }], duration_s: 0.5, timing: "audio", audio_path: "/voice/demo.mp3" },
    });
    const f = vi.fn(async (u: string | URL | Request) => {
      if (String(u) === "http://x/voice/demo.mp3") return new Response(new Uint8Array([9, 9]), { headers: { "content-type": "audio/mpeg" } });
      throw new Error(`unexpected ${String(u)}`);
    });
    const d = deps({ fetch: f as unknown as typeof fetch, elevenLabsKey: "el", voiceId: "voice1", ttsEnabled: true, anthropicKey: "ak" });
    const body = await (await handleExplain(post("/api/voice/explain", { design_response: d0, audio: true }), d)).json();
    expect(body).toMatchObject({ text: "Hi.", cached: "clip", audio_url: "/voice/demo.mp3", audio_base64: "CQk=", cache_key: key });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("in production only explains stored designs (no client-sent design)", async () => {
    const res = await handleExplain(post("/api/voice/explain", { design_response: d0 }), deps({ allowInlineDesign: false }));
    expect(res.status).toBe(400);
  });

  it("explains a stored design by id", async () => {
    const s = fakeStore();
    const id = await s.store.saveDesign({ call_id: "c", home: normaliseFacts({}).home, locks: EMPTY_LOCKS, design: d0 });
    const res = await handleExplain(post("/api/voice/explain", { design_id: id }), deps({ store: s.store, allowInlineDesign: false }));
    expect((await res.json()).text).toContain("10.8 kWp");
  });

  it("rate-limits per client", async () => {
    const d = deps();
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await handleExplain(post("/api/voice/explain", { design_response: d0 }), d)).status);
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
    expect(codes[11]).toBe(429);
  });

  it("explains a stored row that has no engine answer yet by designing it from its home and locks", async () => {
    const s = fakeStore();
    const home = normaliseFacts({ annual_kwh: 4500 }).home;
    let seen: DesignRequest | null = null;
    const store = { ...s.store, getDesign: async () => null, getDesignInputs: async (id: string) => (id === "row-1" ? { home, locks: EMPTY_LOCKS } : null) };
    const d = deps({ store, allowInlineDesign: false, design: async (req) => ((seen = req), mockDesign(req)) });
    const res = await handleExplain(post("/api/voice/explain", { design_id: "row-1" }), d);
    expect(res.status).toBe(200);
    expect(seen!.home).toMatchObject({ annual_kwh: 4500 });
    expect((await handleExplain(post("/api/voice/explain", { design_id: "missing" }), d)).status).toBe(404);
  });

  it("404 for an unknown design id, 400 without a design", async () => {
    expect((await handleExplain(post("/api/voice/explain", { design_id: "nope" }), deps())).status).toBe(404);
    expect((await handleExplain(post("/api/voice/explain", {}), deps())).status).toBe(400);
  });

  it("German template", () => {
    expect(offerTemplate(d0, "de")).toContain("10,8 kWp");
  });
});

// ---------------------------------------------------------------------------
// default deps: never store B's offline estimate as a voice draft
// ---------------------------------------------------------------------------
describe("voiceDeps().design", () => {
  const req: DesignRequest = { installer: "installer_a", home: normaliseFacts({ annual_kwh: 4000 }).home, locks: EMPTY_LOCKS };
  const offline = () => ({ ...mockDesign(req), served: { source: "offline" as const, reason: "tunnel down", ms: 1 } });

  it("rejects the offline estimate when an engine is configured", async () => {
    vi.stubEnv("ENGINE_URL", "https://engine.example");
    const spy = vi.spyOn(engine, "design").mockResolvedValue(offline());
    await expect(voiceDeps(() => {}).design(req)).rejects.toThrow(/engine offline/);
    spy.mockRestore();
    vi.unstubAllEnvs();
  });

  it("accepts the mock when no engine is configured (dev)", async () => {
    vi.stubEnv("ENGINE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_ENGINE_URL", "");
    const spy = vi.spyOn(engine, "design").mockResolvedValue(offline());
    await expect(voiceDeps(() => {}).design(req)).resolves.toMatchObject({ model_version: "MOCK" });
    spy.mockRestore();
    vi.unstubAllEnvs();
  });
});
