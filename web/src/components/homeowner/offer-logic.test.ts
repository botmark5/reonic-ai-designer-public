import { describe, expect, it } from "vitest";
import { mockDesign } from "@/lib/engine-mock";
import { EMPTY_LOCKS, type DesignResponse, type HeatpumpChoice } from "@/lib/types";
import { DAY_END, DAY_START, captionAt, plainText, timeOfDayAt, variantView, type TimedSegment, partLine } from "./offer-logic";

const seg = (start_s: number, end_s: number, time_of_day_h: number | null): TimedSegment => ({ text: "x", moment: null, start_s, end_s, time_of_day_h });

describe("timeOfDayAt: the voice drives the house's clock", () => {
  const segs = [seg(0, 4, null), seg(4, 10, 8), seg(10, 18, 12.5), seg(18, 25, 19), seg(25, 30, null)];
  it("before the first timed sentence the house waits at that sentence's hour", () => {
    expect(timeOfDayAt(0, segs, 30)).toBe(8);
    expect(timeOfDayAt(3.9, segs, 30)).toBe(8);
  });
  it("lands on each sentence's hour once its transition is over", () => {
    expect(timeOfDayAt(6, segs, 30)).toBe(8);
    expect(timeOfDayAt(13, segs, 30)).toBe(12.5);
    expect(timeOfDayAt(22, segs, 30)).toBe(19);
  });
  it("scrubs smoothly into a new hour at the start of its sentence (no jump)", () => {
    const a = timeOfDayAt(10.1, segs, 30);
    const b = timeOfDayAt(10.8, segs, 30);
    expect(a).toBeGreaterThan(8);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(12.5);
  });
  it("holds the last hour through untimed sentences and after the end", () => {
    expect(timeOfDayAt(27, segs, 30)).toBe(19);
    expect(timeOfDayAt(99, segs, 30)).toBe(19);
  });
  it("without timed segments: morning → evening over the clip length", () => {
    expect(timeOfDayAt(0, [], 40)).toBe(7);
    expect(timeOfDayAt(20, [], 40)).toBeCloseTo(13.5, 5);
    expect(timeOfDayAt(40, [], 40)).toBe(20);
    expect(timeOfDayAt(5, [seg(0, 5, null)], 10)).toBeCloseTo(13.5, 5);
  });
  it("always stays inside the house's day", () => {
    const wild = [seg(0, 2, 2), seg(2, 4, 30)];
    for (const t of [0, 1, 3, 5]) {
      const h = timeOfDayAt(t, wild, 5);
      expect(h).toBeGreaterThanOrEqual(DAY_START);
      expect(h).toBeLessThanOrEqual(DAY_END);
    }
    expect(timeOfDayAt(NaN, [], 0)).toBe(7);
  });
});

describe("variantView: the heat pump chip shows the engine's own 'with heat pump' numbers", () => {
  const base = mockDesign({ installer: "installer_a", home: { annual_kwh: 4800, price_eur_kwh: 0.32, load_profile: "H0", has_ev: true, ev_km_year: 15000, existing_pv_kwp: null, existing_battery_kwh: null, heating: "Gas", heating_demand_kwh: null, roof_type: null, house_sqm: null, inhabitants: 4 }, locks: EMPTY_LOCKS });
  const option: HeatpumpChoice = {
    available: true, included: false, kw: 10.5, reasons: ["The home heats with Gas"],
    with_heatpump: { pv_kwp: 12.15, battery_kwh: 10, heatpump_kw: 10.5, capex_total_eur: 40022, savings_first_year_eur: 3100, heating_savings_eur: 792, payback_years: 11.5, net_benefit_lifetime_eur: 37417, autarky: 0.397, load_kwh: 14850 },
    without_heatpump: { pv_kwp: 11.25, battery_kwh: 10, heatpump_kw: null, capex_total_eur: 23238, savings_first_year_eur: 1883, heating_savings_eur: 0, payback_years: 11.2, net_benefit_lifetime_eur: 21771, autarky: 0.589, load_kwh: 7500 },
    difference: { extra_investment_eur: 16784, extra_savings_per_year_eur: 1217, extra_net_benefit_lifetime_eur: 15646 },
  };
  const d: DesignResponse = { ...base, options: { heatpump: option } };

  it("off: the design as the engine sent it", () => {
    const v = variantView(d, false);
    expect(v.design).toBe(d);
    expect(v.heatpump).toBeNull();
    expect(v.numbers.savings).toBe(d.economics!.savings_first_year_eur);
  });
  it("on: heat pump at the engine's option size, PV and battery from with_heatpump, its money and self-made share", () => {
    const v = variantView(d, true);
    expect(v.design.design.heatpump).toMatchObject({ include: true, kw: 10.5 });
    expect(v.design.design.pv.kwp).toBe(12.15);
    expect(v.design.design.battery.kwh).toBe(10);
    expect(v.heatpump).toBe(10.5);
    expect(v.numbers).toMatchObject({ pv: 12.15, battery: 10, autarky: 0.397, savings: 3100, payback: 11.5, capex: 40022, heatingSavings: 792 });
  });
  it("yield scales with the larger roof and is marked as derived", () => {
    const v = variantView(d, true);
    expect(v.numbers.yieldKwh).toBeCloseTo(d.physics.yield_kwh * (12.15 / d.design.pv.kwp!), 5);
  });
  it("never mutates the engine response", () => {
    const before = JSON.stringify(d);
    variantView(d, true);
    expect(JSON.stringify(d)).toBe(before);
  });
  it("no heat pump option (not available, or not offered) → the chip is off, design unchanged", () => {
    const none: DesignResponse = { ...base, options: { heatpump: { available: false, reasons: [] } } };
    expect(variantView(none, true).design).toBe(none);
    expect(variantView(base, true).heatpump).toBeNull();
  });
});

describe("captionAt: the sentence under the house never blinks off between sentences", () => {
  const segs = [seg(0, 4, null), seg(4.4, 10, 8), seg(10.5, 18, 12.5)];
  it("shows the sentence being spoken", () => {
    expect(captionAt(2, segs)).toBe(segs[0]);
    expect(captionAt(12, segs)).toBe(segs[2]);
  });
  it("keeps the last sentence in the short gap before the next", () => {
    expect(captionAt(4.2, segs)).toBe(segs[0]);
    expect(captionAt(10.2, segs)).toBe(segs[1]);
  });
  it("nothing before the first sentence; the last one after the end", () => {
    expect(captionAt(-1, segs)).toBeNull();
    expect(captionAt(99, segs)).toBe(segs[2]);
    expect(captionAt(1, [])).toBeNull();
  });
});

describe("plainText: the explain fallback has no markdown", () => {
  it("strips bold, underline-bold, headings, bullets and voice tags", () => {
    expect(plainText("## Your offer\n**What you get:** 11.25 kWp solar.\n- a __10 kWh__ battery\n* a wallbox [warmly]")).toBe(
      "Your offer What you get: 11.25 kWp solar. a 10 kWh battery a wallbox",
    );
  });
  it("leaves plain sentences and numbers alone", () => {
    expect(plainText("You cover about 59% of your electricity yourself.")).toBe("You cover about 59% of your electricity yourself.");
  });
});

describe("partLine", () => {
  it("a part the homeowner can change lists only the installer's values", () => {
    expect(partLine("battery", 10, [0, 10, 15])).toBe("Battery · 10 kWh. Stores the midday sun for the evening. You can choose none, 10 kWh or 15 kWh below.");
  });
  it("a fixed part says the installer set it", () => {
    expect(partLine("pv", 9.9, [])).toBe("Solar panels · 9.9 kWp. Makes electricity from the sun on your roof. Set by your installer.");
    expect(partLine("battery", null, [0])).toMatch(/^Battery · not included\. .* Set by your installer\.$/);
  });
  it("wallbox and heat pump in words", () => {
    expect(partLine("wallbox", 11, [false, true])).toMatch(/with or without it below\.$/);
    expect(partLine("heatpump", null, [false, true])).toMatch(/An option: you can add it below\.$/);
  });
});
