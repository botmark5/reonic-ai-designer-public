import { describe, expect, it } from "vitest";
import type { DesignResponse } from "@/lib/types";
import { compareRows, insideKeyOf, wantLock, wants, zoneChoices, zoneOf } from "./focus-logic";

const resp = (o: { pv?: number; battery?: number | null; alts?: number[]; range?: [number, number]; wallbox?: boolean; hp?: number | null; hpOption?: number; yieldKwh?: number; autarky?: number; savings?: number }): DesignResponse =>
  ({
    design: {
      pv: { include: true, kwp: o.pv ?? 9.9 },
      battery: { include: o.battery != null && o.battery > 0, kwh: o.battery ?? null, alternatives: (o.alts ?? []).map((kwh) => ({ kwh })), range: o.range },
      wallbox: { include: !!o.wallbox, kw: o.wallbox ? 11 : null },
      heatpump: { include: o.hp != null && o.hp > 0, kw: o.hp ?? null },
    },
    options: o.hpOption ? { heatpump: { available: true, kw: o.hpOption } } : undefined,
    physics: { yield_kwh: o.yieldKwh ?? 9405, self_consumption: 0.4, autarky: o.autarky ?? 0.78, warnings: [] },
    economics: { capex_total_eur: 1, savings_first_year_eur: o.savings ?? 1618, payback_years: 12, savings_lifetime_eur: 1, assumptions: [] },
  }) as unknown as DesignResponse;

describe("wantLock (sizes only from the engine)", () => {
  it("battery yes keeps the current size, no is 0", () => {
    expect(wantLock("battery", resp({ battery: 10 }), true)).toBe(10);
    expect(wantLock("battery", resp({ battery: 10 }), false)).toBe(0);
  });
  it("battery yes without a battery takes the smallest size the engine offered", () => {
    expect(wantLock("battery", resp({ battery: null, alts: [10, 5], range: [5, 15] }), true)).toBe(5);
  });
  it("no, then yes brings back the size from before the change", () => {
    expect(wantLock("battery", resp({ battery: null, alts: [5, 15] }), true, resp({ battery: 9.2 }))).toBe(9.2);
    expect(wantLock("heatpump", resp({ hp: null, hpOption: 10.5 }), true, resp({ hp: 8 }))).toBe(8);
  });
  it("battery yes with no engine size returns null (pick one in the editor)", () => {
    expect(wantLock("battery", resp({ battery: null }), true)).toBeNull();
  });
  it("heat pump yes uses the engine's option size", () => {
    expect(wantLock("heatpump", resp({ hp: null, hpOption: 10.5 }), true)).toBe(10.5);
    expect(wantLock("heatpump", resp({ hp: null }), true)).toBeNull();
    expect(wantLock("heatpump", resp({ hp: 8 }), false)).toBe(0);
  });
  it("wallbox is a plain yes / no; solar has none", () => {
    expect(wantLock("wallbox", resp({}), true)).toBe(true);
    expect(wantLock("wallbox", resp({ wallbox: true }), false)).toBe(false);
    expect(wantLock("pv", resp({}), false)).toBeNull();
  });
  it("wants follows include", () => {
    expect(wants("battery", resp({ battery: 10 }))).toBe(true);
    expect(wants("wallbox", resp({}))).toBe(false);
  });
});

describe("zones", () => {
  it("solar places its inverter; the battery stays indoors", () => {
    expect(insideKeyOf("pv")).toBe("inverter");
    const b = zoneChoices("battery");
    expect(b.map((z) => [z.zone, z.allowed])).toEqual([["basement", true], ["garage", true], ["outside", false]]);
    expect(b[2].why).toMatch(/indoors/);
  });
  it("zoneOf falls back to the default zone", () => {
    expect(zoneOf("heatpump", {})).toBe("outside");
    expect(zoneOf("battery", { battery: "basement" })).toBe("basement");
  });
});

describe("compareRows", () => {
  it("before → after for size, yield, self-sufficiency and savings", () => {
    const rows = compareRows("battery", resp({ battery: 10, autarky: 0.78, savings: 1618 }), resp({ battery: 0, autarky: 0.52, savings: 1200 }));
    expect(rows.map((r) => [r.label, r.before, r.after])).toEqual([
      ["Battery", 10, null],
      ["Solar yield", 9405, 9405],
      ["Self-sufficiency", 78, 52],
      ["Savings, year one", 1618, 1200],
    ]);
  });
});
