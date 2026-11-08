import { describe, expect, it } from "vitest";
import { canSubmit, EMPTY_VISIT, revealFromSteps, toVoiceFacts } from "./visit-logic";

describe("toVoiceFacts", () => {
  it("an empty form sends only nulls", () => {
    expect(Object.values(toVoiceFacts(EMPTY_VISIT)).every((v) => v === null)).toBe(true);
  });
  it("maps answers to the voice pipeline's keys", () => {
    const f = toVoiceFacts({
      ...EMPTY_VISIT, customer_name: " Weber ", address: "Musterstraße 80, München", existing_pv: "no", use_mode: "bill",
      monthly_bill_eur: "120", annual_kwh: "9999", household: 4, daytime: "yes", ev: "planned", ev_km_year: "15.000",
      heating: "gas", heating_age_years: "15", roof_type: "concrete_tile", roof_direction: null, wishes: "  ",
    });
    expect(f).toMatchObject({
      customer_name: "Weber", address: "Musterstraße 80, München", has_existing_pv: "no", existing_pv_kwp: null,
      annual_kwh: null, monthly_bill_eur: 120, household: 4, daytime_presence: "yes", has_ev: "planned", ev_km_year: 15000,
      heating: "gas", heating_age_years: 15, roof_type: "concrete_tile", roof_direction: null, wishes: null,
    });
  });
  it("kWh mode ignores the bill; don't-know stays null; km only with a car", () => {
    const f = toVoiceFacts({ ...EMPTY_VISIT, annual_kwh: "4,800", monthly_bill_eur: "100", existing_pv: "unknown", ev: "no", ev_km_year: "10000" });
    expect(f.annual_kwh).toBe(4800); // thousands comma
    expect(toVoiceFacts({ ...EMPTY_VISIT, existing_pv: "yes", existing_pv_kwp: "6,5" }).existing_pv_kwp).toBe(6.5); // decimal comma
    expect(toVoiceFacts({ ...EMPTY_VISIT, annual_kwh: "4800" }).annual_kwh).toBe(4800);
    expect(f.monthly_bill_eur).toBeNull();
    expect(f.has_existing_pv).toBeNull();
    expect(f.has_ev).toBe("no");
    expect(f.ev_km_year).toBeNull();
  });
  it("existing PV size only when there is PV", () => {
    expect(toVoiceFacts({ ...EMPTY_VISIT, existing_pv: "yes", existing_pv_kwp: "6.5" }).existing_pv_kwp).toBe(6.5);
    expect(toVoiceFacts({ ...EMPTY_VISIT, existing_pv: "no", existing_pv_kwp: "6.5" }).existing_pv_kwp).toBeNull();
  });
});

describe("canSubmit", () => {
  it("needs an address", () => {
    expect(canSubmit(EMPTY_VISIT)).toBe(false);
    expect(canSubmit({ ...EMPTY_VISIT, address: "Hauptstr. 1, Augsburg" })).toBe(true);
  });
});

describe("revealFromSteps", () => {
  it("the house builds as the steps complete", () => {
    expect(revealFromSteps([{ key: "house", state: "active" }])).toMatchObject({ shell: false, panels: false });
    const r = revealFromSteps([{ key: "house", state: "done" }, { key: "model", state: "done" }, { key: "panels", state: "done" }, { key: "parts", state: "active" }]);
    expect(r).toMatchObject({ shell: true, warm: true, panels: true, parts: false });
  });
});
