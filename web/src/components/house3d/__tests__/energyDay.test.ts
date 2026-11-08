import { describe, expect, it } from "vitest";
import { activeFlows, sampleDay, simulateDay, type DayInput } from "../energyDay";

const base: DayInput = {
  kwp: 7.2,
  batteryKwh: 7,
  wallboxKw: 11,
  heatpumpKw: null,
  annualKwh: 4500,
  evKwhPerDay: (15000 / 365) * 0.18,
  roof: { pitchDeg: 35, azimuthDeg: 180 },
};

describe("simulateDay", () => {
  const day = simulateDay(base);

  it("balances energy in every step", () => {
    for (const s of day.steps) {
      const supply = s.pv + s.gridImport + s.batteryOut;
      const use = s.home + s.car + s.batteryIn + s.gridExport;
      expect(Math.abs(supply - use)).toBeLessThan(1e-9);
      expect(s.soc).toBeGreaterThanOrEqual(0.05 - 1e-9);
      expect(s.soc).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it("noon: the panels feed the house, the battery and the car", () => {
    const s = sampleDay(day, 12.5);
    expect(s.pv).toBeGreaterThan(3.5);
    expect(s.pv).toBeLessThan(7.2);
    expect(s.flows.pvHome).toBeGreaterThan(0);
    expect(s.flows.pvBattery).toBeGreaterThan(0);
    expect(s.flows.pvCar).toBeGreaterThanOrEqual(1.4);
    expect(s.flows.gridHome).toBe(0);
  });

  it("evening: the battery runs the house", () => {
    const s = sampleDay(day, 20.5);
    expect(s.pv).toBeLessThan(0.3);
    expect(s.flows.batteryHome).toBeGreaterThan(0.2);
  });

  it("early morning: the grid runs the house, the battery is empty", () => {
    const s = sampleDay(day, 6);
    expect(s.flows.gridHome).toBeGreaterThan(0.1);
    expect(s.flows.batteryHome).toBe(0);
    expect(s.soc).toBeCloseTo(0.05, 2);
  });

  it("a large system still charges the car at noon (surplus charging is spread over the day)", () => {
    const big = simulateDay({ ...base, kwp: 14.4, batteryKwh: 14 });
    expect(sampleDay(big, 12.5).flows.pvCar).toBeGreaterThanOrEqual(1.4);
    expect(sampleDay(big, 12.5).flows.pvCar).toBeLessThanOrEqual(3.7);
  });

  it("the car stops once it has its daily energy", () => {
    const charged = day.steps.reduce((a, s) => a + s.car * 0.25, 0);
    expect(charged).toBeLessThanOrEqual(base.evKwhPerDay + 1e-6);
    expect(charged).toBeGreaterThan(base.evKwhPerDay * 0.9);
  });

  it("without a battery or wallbox there are no such flows", () => {
    const d = simulateDay({ ...base, batteryKwh: null, wallboxKw: null });
    for (const s of d.steps) {
      expect(s.flows.pvBattery + s.flows.batteryHome + s.flows.pvCar).toBe(0);
    }
  });

  it("without PV everything comes from the grid", () => {
    const s = sampleDay(simulateDay({ ...base, kwp: 0 }), 12.5);
    expect(s.pv).toBe(0);
    expect(s.flows.gridHome).toBeGreaterThan(0);
  });

  it("an east roof produces earlier than a west roof", () => {
    const east = simulateDay({ ...base, roof: { pitchDeg: 35, azimuthDeg: 90 } });
    const west = simulateDay({ ...base, roof: { pitchDeg: 35, azimuthDeg: 270 } });
    expect(sampleDay(east, 8).pv).toBeGreaterThan(sampleDay(west, 8).pv);
    expect(sampleDay(west, 18).pv).toBeGreaterThan(sampleDay(east, 18).pv);
  });
});

describe("heat pump in May", () => {
  it("uses a plausible 2-4 kWh of electricity a day (hot water), not more than the household", () => {
    const d = simulateDay({ ...base, heatpumpKw: 9 });
    const kwh = d.steps.slice(0, -1).reduce((a, s) => a + s.heatpump * d.dt, 0);
    expect(kwh).toBeGreaterThan(2);
    expect(kwh).toBeLessThan(4);
  });
});

describe("activeFlows", () => {
  it("lists only flows above a visible threshold, strongest first", () => {
    const s = sampleDay(simulateDay(base), 12.5);
    const f = activeFlows(s);
    expect(f.map((x) => x.id)).toEqual(expect.arrayContaining(["sun-panels", "panels-house", "panels-battery", "panels-car"]));
    expect(f.every((x) => x.kw >= 0.05)).toBe(true);
    const night = activeFlows(sampleDay(simulateDay(base), 6));
    expect(night.map((x) => x.id)).toContain("grid-house");
    expect(night.map((x) => x.id)).not.toContain("battery-house"); // empty after the night
    expect(night[0].id).toBe("grid-house"); // the sun is barely up at 06:00
  });
});

describe("dayInputFrom", () => {
  it("uses the panels actually drawn and only visible components", async () => {
    const { buildSceneSpec } = await import("../sceneSpec");
    const { roofPlanes } = await import("../houseGeometry");
    const { demoDesign, demoHome } = await import("../mock");
    const { dayInputFrom } = await import("../energyDay");
    const spec = buildSceneSpec(demoDesign, demoHome, "planner", roofPlanes, { maxPanels: 10 });
    const d = dayInputFrom(spec, demoDesign.design, demoHome);
    expect(d.kwp).toBeCloseTo(4.5, 6); // 10 panels × 0.45
    expect(d.batteryKwh).toBe(7);
    expect(d.wallboxKw).toBe(11);
    expect(d.heatpumpKw).toBeNull();
    expect(d.evKwhPerDay).toBeCloseTo((15000 / 365) * 0.18, 6);
  });
});
