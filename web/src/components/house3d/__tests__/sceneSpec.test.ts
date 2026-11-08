import { describe, expect, it } from "vitest";
import type { DesignResponse } from "../../../lib/types";
import { isExisting, type RoofPlane } from "../layout";
import { demoDesign, demoDesignBig, demoHome } from "../mock";
import { buildSceneSpec, resolveRoof } from "../sceneSpec";

const planesFor = (): RoofPlane[] => [
  { id: "main", width: 13, slope: 6.1, margin: { side: 0.4, eave: 0.4, ridge: 0.3 } },
  { id: "garage", width: 5, slope: 4.2, margin: { side: 0.3, eave: 0.3, ridge: 0.3 } },
];

const withDesign = (patch: (d: DesignResponse) => void): DesignResponse => {
  const d = structuredClone(demoDesign);
  patch(d);
  return d;
};

describe("buildSceneSpec", () => {
  it("planner view of the demo design", () => {
    const s = buildSceneSpec(demoDesign, demoHome, "planner", planesFor);
    expect(s.layout.placed).toBe(16);
    expect(s.components.pv).toMatchObject({ visible: true, title: "PV", size: "7.2 kWp (16 × 450 W)" });
    expect(s.components.battery).toMatchObject({ visible: true, title: "Battery", size: "7 kWh" });
    expect(s.components.inverter.visible).toBe(true);
    expect(s.components.wallbox).toMatchObject({ visible: true, title: "Wallbox", size: "11 kW" });
    expect(s.components.heatpump.visible).toBe(false);
    expect(s.components.battery.reason).toBe(demoDesign.design.battery.reasons[0]);
    expect(s.flows.map((f) => f.id)).toEqual([
      "sun-panels", "panels-inverter", "inverter-battery", "inverter-house", "house-wallbox", "wallbox-car",
    ]);
    expect(s.flows.find((f) => f.id === "inverter-battery")?.color).toBe("battery");
  });

  it("homeowner titles drop jargon", () => {
    const s = buildSceneSpec(demoDesign, demoHome, "homeowner", planesFor);
    expect(s.components.pv).toMatchObject({ title: "Solar panels", size: "16 panels" });
    expect(s.components.wallbox).toMatchObject({ title: "Car charger", size: null });
    expect(s.summary).toBe("House with 16 solar panels, a 7 kWh battery and a car charger.");
  });

  it("big design adds the heat pump and its flow", () => {
    const s = buildSceneSpec(demoDesignBig, demoHome, "planner", planesFor);
    expect(s.components.heatpump).toMatchObject({ visible: true, size: "9 kW" });
    expect(s.flows.map((f) => f.id)).toContain("house-heatpump");
    expect(s.components.pv.size).toBe("14.4 kWp (32 × 450 W)");
    expect(s.layout.placed).toBe(32);
  });

  it("excluded and null components are hidden, with no NaN or null in labels", () => {
    const d = withDesign((x) => {
      x.design.pv.include = false;
      x.design.battery.kwh = null;
      x.design.wallbox.include = false;
    });
    const s = buildSceneSpec(d, demoHome, "planner", planesFor);
    for (const k of ["pv", "battery", "inverter", "wallbox", "heatpump"] as const) expect(s.components[k].visible).toBe(false);
    expect(s.layout.placed).toBe(0);
    expect(s.flows).toEqual([]);
    expect(JSON.stringify(s)).not.toMatch(/NaN|undefined|null kW/);
    expect(s.summary).toBe("House without solar panels.");
  });

  it("notes panels that do not fit on the roof", () => {
    const d = withDesign((x) => { x.design.pv.kwp = 25.2; }); // 56 panels
    const s = buildSceneSpec(d, demoHome, "planner", planesFor);
    expect(s.layout.requested).toBe(56);
    expect(s.components.pv.note).toBe(`${56 - s.layout.placed} of 56 panels don't fit on this roof`);
  });

  it("Google Solar maxPanels caps the panels drawn", () => {
    const s = buildSceneSpec(demoDesign, demoHome, "planner", planesFor, { maxPanels: 12 });
    expect(s.layout.placed).toBe(12);
    expect(s.components.pv.note).toBe("4 of 16 panels don't fit on this roof");
  });
});

describe("zero panels", () => {
  it("a PV size that rounds to no panel counts as no PV", () => {
    const d = withDesign((x) => { x.design.pv.kwp = 0.2; });
    const s = buildSceneSpec(d, demoHome, "planner", planesFor);
    expect(s.components.pv.visible).toBe(false);
    expect(s.components.inverter.visible).toBe(false);
    expect(s.flows.some((f) => f.from === "sun" || f.from === "panels")).toBe(false);
  });

  it("a roof that fits nothing keeps PV in the legend with a note, but no flows from an empty roof", () => {
    const s = buildSceneSpec(demoDesign, demoHome, "planner", planesFor, { maxPanels: 0 });
    expect(s.layout.placed).toBe(0);
    expect(s.components.pv).toMatchObject({ visible: true, note: "16 of 16 panels don't fit on this roof" });
    expect(s.flows.map((f) => f.id)).not.toContain("sun-panels");
    expect(s.flows.map((f) => f.id)).not.toContain("panels-inverter");
  });
});

describe("resolveRoof", () => {
  it("defaults to 35° south, prefers the roof prop over the home, clamps pitch for drawing", () => {
    const bare = { ...demoHome, tilt_deg: null, orientation_deg: null };
    expect(resolveRoof(bare)).toEqual({ pitchDeg: 35, azimuthDeg: 180 });
    expect(resolveRoof({ ...demoHome, tilt_deg: 30, orientation_deg: 200 })).toEqual({ pitchDeg: 30, azimuthDeg: 200 });
    expect(resolveRoof(demoHome, { pitchDeg: 40, azimuthDeg: 90 })).toEqual({ pitchDeg: 40, azimuthDeg: 90 });
    expect(resolveRoof(demoHome, { pitchDeg: 0 }).pitchDeg).toBe(15);
    expect(resolveRoof(demoHome, { pitchDeg: 70 }).pitchDeg).toBe(50);
  });
});

describe("planner roof fields (home.roof_*)", () => {
  it("the planner's direction and pitch win over Google Solar and the older fields", () => {
    const h = { ...demoHome, orientation_deg: 200, tilt_deg: 30, roof_azimuth: 270, roof_pitch: 25 };
    expect(resolveRoof(h, { azimuthDeg: 90, pitchDeg: 40 })).toEqual({ pitchDeg: 25, azimuthDeg: 270 });
    // removed by the planner (null) falls back to Google, then the older fields
    expect(resolveRoof({ ...h, roof_azimuth: null, roof_pitch: null }, { azimuthDeg: 90 })).toEqual({ pitchDeg: 30, azimuthDeg: 90 });
  });

  it("roof_max_kwp caps the panels drawn (5.85 kWp fits 13 panels)", () => {
    const d = withDesign((x) => { x.design.pv.kwp = 9; });
    const s = buildSceneSpec(d, { ...demoHome, roof_max_kwp: 5.85 }, "planner", planesFor);
    expect(s.layout.placed).toBe(13);
    expect(s.components.pv.note).toBe("7 of 20 panels don't fit on this roof");
  });
});

describe("existing solar (battery retrofit)", () => {
  const retrofit = withDesign((x) => {
    x.design.pv = { ...x.design.pv, include: false, kwp: null }; // what the engine sends for a battery retrofit
    x.design.battery = { ...x.design.battery, include: true, kwh: 10 };
  });
  const existing = { ...demoHome, has_existing_pv: true, existing_pv_kwp: 6 };

  it("draws the panels already on the roof and runs the solar flows into the new battery", () => {
    const s = buildSceneSpec(retrofit, existing, "planner", planesFor);
    expect(s.layout.placed).toBe(13); // 6 kWp ≈ 13 × 450 W
    expect(s.existingPanels).toBe(13);
    expect(s.components.pv).toMatchObject({ visible: true, title: "Existing PV", size: "6 kWp existing", note: null });
    expect(s.components.inverter.visible).toBe(true);
    expect(s.flows.map((f) => f.id)).toEqual(expect.arrayContaining(["sun-panels", "panels-inverter", "inverter-battery", "inverter-house"]));
    expect(buildSceneSpec(retrofit, existing, "homeowner", planesFor).components.pv.title).toBe("Your solar panels");
    expect(s.summary).toBe("House with 13 solar panels, a 10 kWh battery and a car charger.");
  });

  it("new panels go next to the existing ones and both show in the size", () => {
    const d = withDesign((x) => { x.design.pv.kwp = 4.5; });
    const s = buildSceneSpec(d, { ...existing, existing_pv_kwp: 4.5 }, "planner", planesFor);
    expect(s.layout.placed).toBe(20);
    expect(s.existingPanels).toBe(10);
    expect(s.components.pv.size).toBe("4.5 kWp new (10 × 450 W) + 4.5 kWp existing");
  });

  it("existing panels carry their own ids, so 'no solar on the roof' swaps them for the proposal instead of keeping them", () => {
    const d = withDesign((x) => { x.design.pv.kwp = 4.5; });
    const both = buildSceneSpec(d, { ...existing, existing_pv_kwp: 4.5 }, "planner", planesFor);
    expect(both.layout.slots.slice(0, 10).every((p) => isExisting(p.id))).toBe(true);
    expect(both.layout.slots.slice(10).some((p) => isExisting(p.id))).toBe(false);
    const fresh = buildSceneSpec(d, { ...existing, has_existing_pv: false }, "planner", planesFor);
    expect(fresh.existingPanels).toBe(0);
    expect(fresh.layout.slots.some((p) => isExisting(p.id))).toBe(false);
    // the proposal takes the spots the old panels had, under new ids: nothing from the "yes" roof survives the flip
    expect(fresh.layout.slots.filter((p) => both.layout.slots.some((q) => q.id === p.id))).toHaveLength(0);
  });

  it("ignores existing_pv_kwp when the planner said there is no solar on the roof", () => {
    const s = buildSceneSpec(retrofit, { ...existing, has_existing_pv: false }, "planner", planesFor);
    expect(s.layout.placed).toBe(0);
    expect(s.components.pv.visible).toBe(false);
  });
});

describe("review fixes", () => {
  const retrofit = withDesign((x) => {
    x.design.pv = { ...x.design.pv, include: false, kwp: null };
    x.design.battery = { ...x.design.battery, include: true, kwh: 10 };
  });

  it("'yes, there is solar' without a size assumes 8 kWp like the engine", () => {
    const s = buildSceneSpec(retrofit, { ...demoHome, has_existing_pv: true, existing_pv_kwp: null }, "planner", planesFor);
    expect(s.layout.placed).toBe(18);
    expect(s.components.pv.size).toBe("≈ 8 kWp existing (size not given)");
    expect(s.flows.map((f) => f.id)).toContain("inverter-battery");
  });

  it("the roof cap limits only the new panels, like the engine", () => {
    const d = withDesign((x) => { x.design.pv.kwp = 9; });
    const s = buildSceneSpec(d, { ...demoHome, has_existing_pv: true, existing_pv_kwp: 4.5, roof_max_kwp: 5.85 }, "planner", planesFor);
    expect(s.layout.placed).toBe(10 + 13);
    expect(s.existingPanels).toBe(10);
  });

  it("a cap removed by the planner (null) means no cap, even when Google has one", () => {
    const s = buildSceneSpec(demoDesign, { ...demoHome, roof_max_kwp: null }, "planner", planesFor, { maxPanels: 12 });
    expect(s.layout.placed).toBe(16);
  });
});

describe("catalogue sizes keep two decimals", () => {
  it("11.25 kWp stays 11.25 (not 11.3)", () => {
    const d = withDesign((x) => { x.design.pv.kwp = 11.25; });
    expect(buildSceneSpec(d, demoHome, "planner", planesFor).components.pv.size).toMatch(/^11\.25 kWp \(25 × 450 W\)/);
  });
});
