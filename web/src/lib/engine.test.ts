import { describe, expect, it } from "vitest";
import { mockDesign, mockRefine, mockValidate, snapBattery, snapPv } from "./engine-mock";
import { EMPTY_LOCKS, type Home } from "./types";

const home: Home = {
  annual_kwh: 4500, price_eur_kwh: 0.32, load_profile: "H0", has_ev: false, ev_km_year: null,
  existing_pv_kwp: null, existing_battery_kwh: null, heating: "Gas", heating_demand_kwh: null,
  roof_type: null, house_sqm: null, inhabitants: null,
};
const req = (h: Partial<Home> = {}, locks = EMPTY_LOCKS) => ({ installer: "installer_a", home: { ...home, ...h }, locks });

describe("mock engine", () => {
  it("snaps PV to whole 450 W modules and batteries to 5/7/10/14 kWh", () => {
    expect(snapPv(4.5)).toBe(4.5);
    expect(snapPv(10)).toBe(9.9); // 22 modules
    expect(snapBattery(4.5)).toBe(5);
    expect(snapBattery(8.6)).toBe(10);
    expect(snapBattery(7.9)).toBe(7);
    expect(snapBattery(20)).toBe(14);
  });

  it("sizes PV ≈ kWh/1000, battery ≈ PV, no wallbox or heat pump without EV", () => {
    const d = mockDesign(req()).design;
    expect(d.pv.kwp).toBe(4.5);
    expect(d.battery.kwh).toBe(5);
    expect(d.wallbox.include).toBe(false);
    expect(d.heatpump.include).toBe(false);
  });

  it("an EV adds PV and a wallbox", () => {
    const d = mockDesign(req({ has_ev: true, ev_km_year: 15000 })).design;
    expect(d.pv.kwp).toBe(snapPv(4.5 + 2.7));
    expect(d.wallbox.include).toBe(true);
    expect(d.wallbox.kw).toBe(11);
  });

  it("respects locks, including 0 = none", () => {
    const d = mockDesign(req({}, { ...EMPTY_LOCKS, pv_kwp: 12.15, battery_kwh: 0 })).design;
    expect(d.pv.kwp).toBe(12.15);
    expect(d.pv.confidence).toBe(1);
    expect(d.battery.include).toBe(false);
    expect(d.battery.kwh).toBeNull();
  });

  it("is deterministic", () => {
    expect(mockDesign(req())).toEqual(mockDesign(req()));
  });

  it("is marked as mock", () => {
    const r = mockDesign(req());
    expect(r.model_version).toBe("MOCK");
    expect(r.design.pv.reasons.every((s) => s.startsWith("[mock]"))).toBe(true);
  });

  it("refine: 'buying an EV next year' sets has_ev and adds a wallbox", () => {
    const r = mockRefine({ text: "family is buying an EV next year", home, locks: EMPTY_LOCKS });
    expect(r.changes.has_ev).toBe(true);
    expect(r.design.design.wallbox.include).toBe(true);
    expect(r.design.design.pv.kwp!).toBeGreaterThan(4.5);
  });

  it("refine: 'no battery' locks battery to 0", () => {
    const r = mockRefine({ text: "customer wants no battery", home, locks: EMPTY_LOCKS });
    expect(r.locks?.battery_kwh).toBe(0);
    expect(r.design.design.battery.include).toBe(false);
  });

  it("validate flags an unusually large battery", () => {
    const v = mockValidate({ installer: "installer_a", home, design: { pv_kwp: 4.5, battery_kwh: 14, wallbox: false, heatpump_kw: null } });
    const bat = v.flags.find((f) => f.component === "battery")!;
    expect(bat.level).toBe("warn");
    expect(bat.percentile).toBeGreaterThanOrEqual(90);
  });
});
