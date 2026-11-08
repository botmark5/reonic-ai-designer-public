/**
 * A modelled sunny day for the time-of-day story. Pure: 15-minute steps, energy-balanced.
 * PV from a clear-sky model on the real roof plane, an H0-like household profile scaled to the annual demand,
 * EV surplus charging (paced over the sunny hours), a small heat-pump load (hot water in May), a battery with forecast-based charging and SOC
 * limits, then the grid.
 * Illustrative, not a forecast: the UI labels it "Sunny day in May, modelled".
 */
import { MAY_DAY, sunPosition, type Place, type SunPos } from "./sun";

export interface DayInput {
  kwp: number;
  batteryKwh: number | null;
  /** null = no wallbox (no car charging). */
  wallboxKw: number | null;
  heatpumpKw: number | null;
  annualKwh: number;
  evKwhPerDay: number;
  roof: { pitchDeg: number; azimuthDeg: number };
  place?: Place;
}

export interface Flows {
  pvHome: number;
  pvBattery: number;
  pvCar: number;
  pvGrid: number;
  batteryHome: number;
  gridHome: number;
}

export interface DayStep {
  t: number; // hours, local clock
  sun: SunPos;
  pv: number; // kW
  home: number; // household + heat pump, kW
  heatpump: number;
  car: number;
  batteryIn: number;
  batteryOut: number;
  soc: number; // 0..1, at this moment
  gridImport: number;
  gridExport: number;
  flows: Flows;
}

export interface Day {
  steps: DayStep[];
  dt: number;
  batteryKwh: number;
}

const DT = 0.25;
const SOC_MIN = 0.05;
const SOC_START = 0.25; // at midnight
const D = Math.PI / 180;
const CAR_MIN = 1.4; // kW, smallest single-phase charging current
const CAR_MAX = 3.7; // kW, single-phase surplus charging
const CAR_DONE_BY = 16; // h

/** Share of daily household energy per hour (H0-like: night low, morning and evening peaks). */
const HOURLY = [
  0.025, 0.02, 0.018, 0.017, 0.018, 0.022, 0.035, 0.05, 0.048, 0.042, 0.04, 0.045,
  0.05, 0.045, 0.04, 0.038, 0.042, 0.052, 0.065, 0.07, 0.065, 0.055, 0.045, 0.033,
];
const HOURLY_SUM = HOURLY.reduce((a, b) => a + b, 0);

function pvPower(kwp: number, sun: SunPos, roof: DayInput["roof"]): number {
  if (kwp <= 0 || sun.elevationDeg <= 0) return 0;
  const zenDeg = 90 - sun.elevationDeg;
  const am = 1 / (Math.cos(zenDeg * D) + 0.50572 * Math.pow(96.07995 - zenDeg, -1.6364));
  const dni = 1353 * Math.pow(0.7, Math.pow(am, 0.678));
  const dhi = 0.1 * dni;
  const el = sun.elevationDeg * D;
  const az = sun.azimuthDeg * D;
  const b = roof.pitchDeg * D;
  const g = roof.azimuthDeg * D;
  // sun direction and roof normal in the same frame (+x east, +y up, +z south)
  const s = [Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)];
  const n = [Math.sin(g) * Math.sin(b), Math.cos(b), -Math.cos(g) * Math.sin(b)];
  const cosInc = Math.max(0, s[0] * n[0] + s[1] * n[1] + s[2] * n[2]);
  const poa = dni * cosInc + dhi * ((1 + Math.cos(b)) / 2);
  return Math.max(0, (kwp * poa) / 1000) * 0.8; // temperature, inverter and wiring losses
}

function household(annualKwh: number, t: number): number {
  const h = Math.floor(t) % 24;
  return ((Math.max(0, annualKwh) / 365) * HOURLY[h]) / HOURLY_SUM; // kWh in that hour = average kW
}

function heatpumpLoad(kw: number | null, t: number): number {
  if (!kw || kw <= 0) return 0;
  const hotWater = (t >= 6 && t < 8) || (t >= 18 && t < 21);
  // May: hot water only, ≈ 3 kWh of electricity a day for a 9 kW unit
  return kw * (hotWater ? 0.045 : 0.006);
}

export function simulateDay(input: DayInput): Day {
  const place = input.place ?? MAY_DAY;
  const cap = input.batteryKwh && input.batteryKwh > 0 ? input.batteryKwh : 0;
  const pmax = cap ? Math.min(5, Math.max(2.5, cap * 0.5)) : 0;
  // forecast-based charging: spread over the sunny hours (keeps feed-in peaks low), ~C/5.5
  const chargeMax = cap ? Math.min(pmax, cap * 0.18) : 0;
  const carMax = input.wallboxKw && input.wallboxKw > 0 ? input.wallboxKw : 0;
  let soc = cap ? SOC_START : 0;
  let carNeed = carMax ? Math.max(0, input.evKwhPerDay) : 0;
  const steps: DayStep[] = [];

  for (let i = 0; i <= 24 / DT; i++) {
    const t = i * DT;
    const sun = sunPosition(t, place);
    const pv = pvPower(Math.max(0, input.kwp), sun, input.roof);
    const hp = heatpumpLoad(input.heatpumpKw, t);
    const home = household(input.annualKwh, t) + hp;

    const pvHome = Math.min(pv, home);
    let surplus = pv - pvHome;
    let car = 0;
    if (carMax && carNeed > 1e-9 && surplus >= CAR_MIN) {
      // PV-surplus charging (single phase, 1.4–3.7 kW), paced to finish by mid-afternoon
      const paced = carNeed / Math.max(0.5, CAR_DONE_BY - t);
      car = Math.min(Math.max(CAR_MIN, paced), Math.min(CAR_MAX, carMax), surplus, carNeed / DT);
      surplus -= car;
    }
    const room = cap ? ((1 - soc) * cap) / DT : 0;
    const batteryIn = Math.max(0, Math.min(surplus, chargeMax, room));
    const pvGrid = surplus - batteryIn;

    const deficit = home - pvHome;
    const avail = cap ? ((soc - SOC_MIN) * cap) / DT : 0;
    const batteryOut = avail > 1e-9 ? Math.max(0, Math.min(deficit, pmax, avail)) : 0;
    const gridHome = deficit - batteryOut;

    steps.push({
      t, sun, pv, home, heatpump: hp, car, batteryIn, batteryOut, soc,
      gridImport: gridHome, gridExport: pvGrid,
      flows: { pvHome, pvBattery: batteryIn, pvCar: car, pvGrid, batteryHome: batteryOut, gridHome },
    });

    if (cap) soc = Math.min(1, Math.max(SOC_MIN, soc + ((batteryIn - batteryOut) * DT) / cap));
    carNeed = Math.max(0, carNeed - car * DT);
  }
  return { steps, dt: DT, batteryKwh: cap };
}

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

/** The day at any clock time (linear between steps). */
export function sampleDay(day: Day, hour: number): DayStep {
  const x = Math.min(24, Math.max(0, hour)) / day.dt;
  const i = Math.min(day.steps.length - 2, Math.floor(x));
  const k = x - i;
  const a = day.steps[i];
  const b = day.steps[i + 1];
  if (k < 1e-9) return a;
  const f = (key: keyof Flows) => lerp(a.flows[key], b.flows[key], k);
  return {
    t: hour,
    sun: { elevationDeg: lerp(a.sun.elevationDeg, b.sun.elevationDeg, k), azimuthDeg: lerp(a.sun.azimuthDeg, b.sun.azimuthDeg, k) },
    pv: lerp(a.pv, b.pv, k), home: lerp(a.home, b.home, k), heatpump: lerp(a.heatpump, b.heatpump, k),
    car: lerp(a.car, b.car, k), batteryIn: lerp(a.batteryIn, b.batteryIn, k), batteryOut: lerp(a.batteryOut, b.batteryOut, k),
    soc: lerp(a.soc, b.soc, k), gridImport: lerp(a.gridImport, b.gridImport, k), gridExport: lerp(a.gridExport, b.gridExport, k),
    flows: {
      pvHome: f("pvHome"), pvBattery: f("pvBattery"), pvCar: f("pvCar"),
      pvGrid: f("pvGrid"), batteryHome: f("batteryHome"), gridHome: f("gridHome"),
    },
  };
}

export type FlowNodeId = "sun" | "panels" | "inverter" | "house" | "battery" | "wallbox" | "car" | "grid" | "heatpump";

export interface LiveFlow {
  id: string;
  /** Path through the scene, first to last. */
  path: FlowNodeId[];
  kw: number;
}

const VISIBLE_KW = 0.05;

/** The flows to draw at this moment, strongest first. */
export function activeFlows(s: DayStep): LiveFlow[] {
  const all: LiveFlow[] = [
    { id: "sun-panels", path: ["sun", "panels"], kw: s.pv },
    { id: "panels-house", path: ["panels", "inverter", "house"], kw: s.flows.pvHome },
    { id: "panels-battery", path: ["panels", "inverter", "battery"], kw: s.flows.pvBattery },
    { id: "panels-car", path: ["panels", "inverter", "wallbox", "car"], kw: s.flows.pvCar },
    { id: "panels-grid", path: ["panels", "inverter", "grid"], kw: s.flows.pvGrid },
    { id: "battery-house", path: ["battery", "inverter", "house"], kw: s.flows.batteryHome },
    { id: "grid-house", path: ["grid", "house"], kw: s.flows.gridHome },
    { id: "house-heatpump", path: ["house", "heatpump"], kw: s.heatpump },
  ];
  return all.filter((f) => f.kw >= VISIBLE_KW).sort((a, b) => b.kw - a.kw);
}

/** What the day simulation needs, from the design as drawn (panels actually on the roof, visible components). */
export function dayInputFrom(
  spec: { layout: { placed: number }; components: Record<"pv" | "battery" | "wallbox" | "heatpump", { visible: boolean }>; roof: { pitchDeg: number; azimuthDeg: number } },
  design: { battery: { kwh: number | null }; wallbox: { kw: number | null }; heatpump: { kw: number | null } },
  home: { annual_kwh: number; ev_km_year: number | null },
  place?: Place,
): DayInput {
  const c = spec.components;
  return {
    kwp: c.pv.visible ? spec.layout.placed * 0.45 : 0,
    batteryKwh: c.battery.visible ? design.battery.kwh : null,
    wallboxKw: c.wallbox.visible ? (design.wallbox.kw ?? 11) : null,
    heatpumpKw: c.heatpump.visible ? design.heatpump.kw : null,
    annualKwh: Math.max(0, home.annual_kwh || 0),
    evKwhPerDay: c.wallbox.visible ? ((home.ev_km_year ?? 12000) / 365) * 0.18 : 0,
    roof: spec.roof,
    place,
  };
}
