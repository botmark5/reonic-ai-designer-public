import { describe, expect, it, vi } from "vitest";
import { factsFromForm, formDraft, handleIntake } from "./intake";
import type { SolarResult } from "./solar";
import type { DesignRequest, DesignResponse } from "./types";
import { normaliseFacts } from "./voice";

const design = { design: { pv: { include: true, kwp: 10.8 } }, model_version: "t" } as unknown as DesignResponse;
const roof: SolarResult = {
  status: "ok", address: "Musterstraße 80", lat: 48.17, lng: 11.59, max_panels: 222, panel_watts: 400, sunshine_hours_year: 1600,
  imagery_quality: "HIGH", imagery_date: null,
  segments: [{ pitch_deg: 32, azimuth_deg: 178, area_m2: 80 }, { pitch_deg: 32, azimuth_deg: 358, area_m2: 80 }],
} as unknown as SolarResult;
const post = (answers: unknown) => new Request("http://x/api/intake", { method: "POST", body: JSON.stringify({ answers }) });
const deps = (over: Partial<{ design: (r: DesignRequest) => Promise<DesignResponse>; solar: (a: string) => Promise<SolarResult> }> = {}) => ({
  installer: "inst",
  design: vi.fn(over.design ?? (async () => design)),
  solar: vi.fn(over.solar ?? (async () => roof)),
});

describe("POST /api/intake", () => {
  it("does not draft before a use, bill or household is known, but already looks the roof up", async () => {
    const d = deps();
    const r = await (await handleIntake(post({ customer_name: "Anna", address: "Musterstraße 80" }), d)).json();
    expect(r).toMatchObject({ ready: false, design: null, solar: { status: "ok" } });
    expect(d.design).not.toHaveBeenCalled();
  });

  it("drafts with the voice agent's home plus Google's roof, exactly like create_design", async () => {
    const d = deps();
    const answers = { address: "Musterstraße 80", monthly_bill_eur: 120, has_ev: "planned", household: 4 };
    const r = await (await handleIntake(post(answers), d)).json();
    expect(r.ready).toBe(true);
    expect(r.design).toEqual(design);
    const sent = (d.design.mock.calls[0] as [DesignRequest])[0];
    expect(sent.installer).toBe("inst");
    expect(sent.home).toEqual({ ...normaliseFacts(answers).home, orientation_deg: 178, tilt_deg: 32 });
    expect(r.assumptions.join(" ")).toMatch(/15,000 km.*Google Solar/);
  });

  it("a stated roof direction wins over Google's", async () => {
    const d = deps();
    await handleIntake(post({ address: "x", household: 2, roof_direction: "west" }), d);
    expect((d.design.mock.calls[0] as [DesignRequest])[0].home).toMatchObject({ orientation_deg: 270, tilt_deg: 32 });
  });

  it("engine down: ready without a design, says why", async () => {
    const r = await (await handleIntake(post({ household: 2 }), deps({ design: async () => { throw new Error("offline"); } }))).json();
    expect(r).toMatchObject({ ready: true, design: null, design_error: "engine_unavailable" });
  });

  it("no address: no roof lookup", async () => {
    const d = deps();
    await handleIntake(post({ household: 3 }), d);
    expect(d.solar).not.toHaveBeenCalled();
  });

  it("400 on bad bodies", async () => {
    expect((await handleIntake(new Request("http://x", { method: "POST", body: "nope" }), deps())).status).toBe(400);
    expect((await handleIntake(post([1, 2]), deps())).status).toBe(400);
    expect((await handleIntake(post(null), deps())).status).toBe(400);
  });
});

describe("factsFromForm / formDraft (/visit)", () => {
  const form = {
    customer_name: "Anna Weber", address: "Musterstraße 80", has_existing_pv: false, monthly_bill_eur: 120, household: 4,
    daytime_presence: true, has_ev: "planned" as const, ev_km_year: null, heating: "gas", heating_age_years: 18, roof_type: "clay_tile",
    roof_direction: "", wishes: "", annual_kwh: null,
  };

  it("a form gives the same home as the call with the same answers", () => {
    const spoken = normaliseFacts({
      customer_name: "Anna Weber", address: "Musterstraße 80", has_existing_pv: "no", monthly_bill_eur: 120, household: "family of four",
      daytime_presence: "yes", has_ev: "planned", heating: "gas", heating_age_years: 18, roof_type: "clay_tile",
    });
    const typed = factsFromForm(form);
    expect(typed.home).toEqual(spoken.home);
    expect(typed.assumptions).toEqual(spoken.assumptions);
    expect(typed.home).toMatchObject({ annual_kwh: 4100, has_ev: true, ev_km_year: 15000, has_existing_pv: false, roof_type: "clay_tile", load_profile: "H0" });
  });

  it("empty fields are 'not answered'; 'now' means an EV today; booleans work", () => {
    expect(factsFromForm({ has_ev: "now" }).home.has_ev).toBe(true);
    expect(factsFromForm({ has_ev: false, ev_km_year: null }).home).toMatchObject({ has_ev: false, ev_km_year: null });
    expect(factsFromForm({ has_existing_pv: true, existing_pv_kwp: 8 }).home).toMatchObject({ has_existing_pv: true, existing_pv_kwp: 8 });
    expect(factsFromForm({ roof_direction: "" }).home.orientation_deg).toBeNull();
  });

  it("formDraft = /intake: Google's roof when no direction is given, then the engine", async () => {
    const d = deps();
    const r = await formDraft(form, d);
    expect(r).toMatchObject({ ready: true, design });
    expect((d.design.mock.calls[0] as [DesignRequest])[0].home).toEqual({ ...factsFromForm(form).home, orientation_deg: 178, tilt_deg: 32 });
    const viaIntake = deps();
    await handleIntake(post({ customer_name: "Anna Weber", address: "Musterstraße 80", has_existing_pv: "no", monthly_bill_eur: 120, household: 4, daytime_presence: "yes", has_ev: "planned", heating: "gas", heating_age_years: 18, roof_type: "clay_tile" }), viaIntake);
    expect((viaIntake.design.mock.calls[0] as [DesignRequest])[0]).toEqual((d.design.mock.calls[0] as [DesignRequest])[0]);
  });
});
