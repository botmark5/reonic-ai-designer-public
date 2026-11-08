import { describe, expect, it } from "vitest";
import { allowedLockValues, numbersIn, numbersWithUnits, plannerNegates } from "./agent";
import { mockDesign } from "./engine-mock";
import { EMPTY_LOCKS } from "./types";

const r = mockDesign({
  installer: "installer_a",
  home: { annual_kwh: 4800, price_eur_kwh: 0.32, load_profile: "H0", has_ev: true, ev_km_year: 15000, existing_pv_kwp: null,
    existing_battery_kwh: null, heating: "Gas", heating_demand_kwh: null, roof_type: null, house_sqm: null, inhabitants: 4 },
  locks: EMPTY_LOCKS,
});

describe("agent guards", () => {
  it("reads planner numbers in English and German notation", () => {
    expect(numbersIn("make the battery 10 kWh")).toEqual([10]);
    expect(numbersIn("12,5 kWp and 15.000 km")).toEqual([12.5, 15000]);
    expect(numbersIn("15,000 km a year")).toEqual([15000]);
  });

  it("attaches units", () => {
    expect(numbersWithUnits("family of 4, battery 10 kWh, 9.9 kWp, €0.35, 12 kW")).toEqual([
      { value: 4, unit: null }, { value: 10, unit: "kwh" }, { value: 9.9, unit: "kwp" }, { value: 0.35, unit: "eur" }, { value: 12, unit: "kw" },
    ]);
  });

  it("only allows lock values the engine offered or the planner wrote with the right unit", () => {
    const battery = allowedLockValues("battery", r, [], true);
    for (const a of r.design.battery.alternatives ?? []) expect(battery.has(a.kwh)).toBe(true);
    expect(battery.has(23)).toBe(false);
    expect(allowedLockValues("battery", r, numbersWithUnits("make it 23 kWh"), false).has(23)).toBe(true);
    // "family of 4" is not a 4 kWh battery
    expect(allowedLockValues("battery", r, numbersWithUnits("family of 4 wants more battery"), false).has(4)).toBe(false);
    expect(allowedLockValues("pv", r, [], false).has(r.design.pv.kwp!)).toBe(true);
    expect(allowedLockValues("pv", r, [], false).has(42)).toBe(false);
  });

  it("allows 'none' only when the planner says no / without", () => {
    expect(plannerNegates("customer wants no battery")).toBe(true);
    expect(plannerNegates("ohne Speicher bitte")).toBe(true);
    expect(plannerNegates("as independent as possible")).toBe(false);
    expect(allowedLockValues("battery", r, [], false).has(0)).toBe(false);
    expect(allowedLockValues("battery", r, [], true).has(0)).toBe(true);
  });
});

describe("no new PV: the engine's PV range is ignored", () => {
  it("offers no PV range ends as lock values when pv.include is false", () => {
    const r = { design: { pv: { include: false, kwp: 0, range: [7.2, 11.25] } } } as unknown as Parameters<typeof allowedLockValues>[1];
    expect([...allowedLockValues("pv", r, [], false)]).toEqual([]);
  });
});
