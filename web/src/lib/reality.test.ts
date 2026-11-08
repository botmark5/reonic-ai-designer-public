import { describe, expect, it } from "vitest";
import { verdicts, coverage, headlineSource, headlines, trustedCoverage } from "./reality";
import type { ExpertVariant } from "./types";

const v = (o: Partial<ExpertVariant>): ExpertVariant => ({ option_number: 1, is_primary: true, pv_kwp: 9, battery_kwh: 10, has_wallbox: false, heatpump_kw: 0, ...o });
const cat = [5, 7, 10, 14, 15];

describe("reality verdicts", () => {
  it("PV within 1 kWp of the expert is a match", () => {
    const r = verdicts({ pv: 8.55, battery: 10, wallbox: false, heatpump: null, heatpumpOption: null }, [v({})], cat);
    expect(r.pv.kind).toBe("match");
    expect(r.battery.kind).toBe("match");
    expect(r.wallbox.kind).toBe("match");
    expect(r.heatpump.kind).toBe("match");
  });

  it("inside the range of several offered variants counts as a hit", () => {
    const variants = [v({ pv_kwp: 6.75, battery_kwh: 10 }), v({ is_primary: false, option_number: 2, pv_kwp: 12.15, battery_kwh: 15 })];
    const r = verdicts({ pv: 10.8, battery: 14, wallbox: false, heatpump: null, heatpumpOption: null }, variants, cat);
    expect(r.pv.kind).toBe("range");
    expect(r.battery.kind).toBe("range");
  });

  it("battery one catalogue step away is close, further is off", () => {
    expect(verdicts({ pv: 9, battery: 14, wallbox: false, heatpump: null, heatpumpOption: null }, [v({ battery_kwh: 10 })], cat).battery.kind).toBe("close");
    expect(verdicts({ pv: 9, battery: 5, wallbox: false, heatpump: null, heatpumpOption: null }, [v({ battery_kwh: 14 })], cat).battery.kind).toBe("off");
  });

  it("no battery inside a [none, 5.12] offer range is a hit, like evaluate.py", () => {
    const variants = [v({ battery_kwh: 0 }), v({ is_primary: false, option_number: 2, battery_kwh: 5.12 })];
    expect(verdicts({ pv: 9, battery: null, wallbox: false, heatpump: null, heatpumpOption: null }, variants, cat).battery.hit).toBe(true);
  });

  it("yes/no disagreements are flagged", () => {
    const r = verdicts({ pv: null, battery: 5, wallbox: true, heatpump: null, heatpumpOption: null }, [v({ pv_kwp: 9, has_wallbox: false })], cat);
    expect(r.pv.kind).toBe("missing");
    expect(r.wallbox.kind).toBe("extra");
  });

  it("an expert heat pump that we offer as an option is a hit", () => {
    const r = verdicts({ pv: 9, battery: 10, wallbox: false, heatpump: null, heatpumpOption: 12 }, [v({ heatpump_kw: 12.5 })], cat);
    expect(r.heatpump.kind).toBe("option");
  });
});

describe("headline metrics", () => {
  it("compares with the best baseline per metric and names it", async () => {
    const { headlines } = await import("./reality");
    const h = headlines({
      design_model: { pv_kwp_mae_all_projects: 2.94, has_battery_accuracy: 86.7 },
      baseline_band_median: { pv_kwp_mae_all_projects: 3.77, has_battery_accuracy: 89.8 },
      baseline_kwh_per_1000: { pv_kwp_mae_all_projects: 4.95, has_battery_accuracy: 89.8 },
    });
    const pv = h.find((x) => x.key === "pv_kwp_mae_all_projects")!;
    expect(pv.base).toBe(3.77);
    expect(pv.baseName).toBe("consumption-band median");
    expect(pv.wins).toBe(true);
    const bat = h.find((x) => x.key === "has_battery_accuracy")!;
    expect(bat.wins).toBe(false); // shown honestly
  });
});

describe("headlineSource / coverage (old and new /eval shapes)", () => {
  const all = { design_model: { n_projects: 323, pv_kwp_mae_all_projects: 2.9 }, baseline_band_median: { pv_kwp_mae_all_projects: 3.9 } };
  it("falls back to all projects on the old shape", () => {
    const s = headlineSource({ metrics: all });
    expect(s.fullOnly).toBe(false);
    expect(s.metrics).toBe(all);
    expect(s.addOns).toBeNull();
  });
  it("uses new full systems for the headline and keeps add-ons apart", () => {
    const full = { design_model: { n_projects: 42 } };
    const addOns = { design_model: { n_projects: 281 } };
    const s = headlineSource({ metrics: all, segments: { full_designs: full, add_ons: addOns } });
    expect(s.fullOnly).toBe(true);
    expect(s.metrics).toBe(full);
    expect(s.addOns).toBe(addOns);
  });
  it("reads P10–P90 coverage under any known key, else null", () => {
    expect(coverage({ pv_interval_coverage_pct: 79.6 })).toBe(79.6);
    expect(coverage({ pv_p10_p90_coverage_pct: 81 })).toBe(81);
    expect(coverage({ pv_kwp_mae: 2 })).toBeNull();
    expect(coverage(undefined)).toBeNull();
  });
});

describe("headlines ties", () => {
  it("a tie at the shown precision is neither a win nor a loss", () => {
    const [h] = headlines({ design_model: { has_battery_accuracy: 69.2 }, baseline_band_median: { has_battery_accuracy: 68.9 } }, "design_model", [
      { key: "has_battery_accuracy", label: "x", better: "higher", unit: "%" },
    ]);
    expect(h.tie).toBe(true);
    expect(h.wins).toBeNull();
  });
});

describe("answered mode and trusted coverage", () => {
  it("new systems from the answered slice, add-ons and all homes WITHOUT the answer", () => {
    const full = { design_model: { n_projects: 253, pv_n: 240, pv_interval_coverage_pct: 79.1 } };
    const addOnsAnswered = { design_model: { n_projects: 62, has_pv_accuracy: 87 } };
    const addOnsPlain = { design_model: { n_projects: 62, pv_n: 4, has_pv_accuracy: 77.4, pv_interval_coverage_pct: 0 } };
    const all = { design_model: { pv_kwp_mae_all_projects: 2.94 } };
    const s = headlineSource({
      metrics: all,
      segments: { full_designs: { design_model: { pv_interval_coverage_pct: 80.7 } }, add_ons: addOnsPlain },
      with_existing_pv_answer: { metrics: { design_model: { pv_kwp_mae_all_projects: 2.19 } }, segments: { full_designs: full, add_ons: addOnsAnswered } },
    });
    expect(s.answered).toBe(true);
    expect(s.metrics).toBe(full); // the answer is "new system" for every home here: fair
    expect(s.overall).toBe(all); // all homes: never the answered (label-derived) numbers
    expect(s.addOns).toBe(addOnsPlain); // add-on sales: without the answer
    expect(trustedCoverage(s.metrics.design_model)).toBe(79.1);
    expect(trustedCoverage(s.addOns?.design_model)).toBeNull(); // only 4 homes
    expect(trustedCoverage({ pv_n: 30, pv_interval_coverage_pct: null })).toBeNull();
  });
  it("without unanswered segments the answered add-ons are the only ones available", () => {
    const addOnsAnswered = { design_model: { n_projects: 62 } };
    const s = headlineSource({ metrics: { design_model: {} }, with_existing_pv_answer: { segments: { full_designs: { design_model: { n_projects: 1 } }, add_ons: addOnsAnswered } } });
    expect(s.addOns).toBe(addOnsAnswered);
  });
});

describe("level with the rule (scorecard 03:00)", () => {
  const one = (key: string, unit: "%" | "kWp", better: "higher" | "lower", ours: number, base: number) =>
    headlines({ design_model: { [key]: ours }, baseline_band_median: { [key]: base } }, "design_model", [{ key, label: "x", better, unit }])[0];
  it("a gap of 2 points or less is level, neither a win nor a loss", () => {
    const h = one("pv_variant_hit_tolerant_pct", "%", "higher", 38.4, 37.1);
    expect(h.level).toBe(true);
    expect(h.wins).toBeNull();
    expect(one("has_wallbox_accuracy", "%", "higher", 73, 72).wins).toBeNull();
    expect(one("has_pv_accuracy", "%", "higher", 77, 6).wins).toBe(true);
    expect(one("has_battery_accuracy", "%", "higher", 86.7, 89.8).wins).toBe(false);
  });
  it("a solar error within 5 % of the rule is level (2.50 vs 2.62)", () => {
    const h = one("pv_kwp_mae_all_projects", "kWp", "lower", 2.5, 2.62);
    expect(h.level).toBe(true);
    expect(h.wins).toBeNull();
    expect(one("pv_kwp_mae_all_projects", "kWp", "lower", 2.94, 3.77).wins).toBe(true);
  });
});

describe("expertDesign", () => {
  it("puts the expert's primary variant into our response shape, none where the expert sold none", async () => {
    const { expertDesign } = await import("./reality");
    const ours = {
      design: {
        pv: { include: true, kwp: 9.9, range: [8, 12], confidence: 0.8, reasons: ["x"] },
        battery: { include: true, kwh: 10, range: [5, 10], confidence: 0.7, reasons: [] },
        wallbox: { include: false, kw: null, confidence: 0.6, reasons: [] },
        heatpump: { include: false, kw: null, confidence: 0.6, reasons: [] },
      },
    } as unknown as Parameters<typeof expertDesign>[0];
    const e = expertDesign(ours, [
      { option_number: 2, is_primary: false, pv_kwp: 12, battery_kwh: null, has_wallbox: false, heatpump_kw: null },
      { option_number: 1, is_primary: true, pv_kwp: null, battery_kwh: 5, has_wallbox: true, heatpump_kw: 9 },
    ]);
    expect(e.design.pv).toMatchObject({ include: false, kwp: null });
    expect(e.design.battery).toMatchObject({ include: true, kwh: 5 });
    expect(e.design.wallbox).toMatchObject({ include: true, kw: 11 });
    expect(e.design.heatpump).toMatchObject({ include: true, kw: 9 });
    expect(e.design.pv.reasons).toEqual([]);
  });
});

describe("top3 (issue #57)", () => {
  it("reads pv_top3_within_1.5_pct when at least 20 homes with solar stand behind it", async () => {
    const { top3 } = await import("./reality");
    expect(top3({ "pv_top3_within_1.5_pct": 67.19, pv_n: 253 })).toBe(67.19);
    expect(top3({ "pv_top3_within_1.5_pct": 0, pv_n: 4 })).toBeNull();
    expect(top3({ pv_n: 253 })).toBeNull();
    expect(top3(undefined)).toBeNull();
  });
});

describe("caseChips", () => {
  it("labels the two-houses cases and hides the older duplicate of each", async () => {
    const { caseChips } = await import("./reality");
    const d = (role: string) => ({ role, why: "", project_id: role });
    const chips = caseChips([
      d("two_houses_typical_pv_battery"), d("two_houses_ev_wallbox"), d("two_houses_large_home"),
      d("typical_pv_battery"), d("heatpump_option"), d("battery_retrofit"), d("experts_disagree"), d("ev_wallbox"),
    ]);
    expect(chips.map((c) => c.label)).toEqual(["Typical home", "EV owner", "Large home", "Heat pump case", "Battery retrofit", "Experts disagree"]);
  });
  it("keeps the older cases when the engine has no two-houses set yet", async () => {
    const { caseChips } = await import("./reality");
    const chips = caseChips([{ role: "typical_pv_battery", why: "", project_id: "a" }, { role: "ev_wallbox", why: "", project_id: "b" }, { role: "new_role", why: "", project_id: "c" }]);
    expect(chips.map((c) => c.label)).toEqual(["Typical home", "EV owner", "New role"]);
  });
});
