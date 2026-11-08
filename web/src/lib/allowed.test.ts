import { describe, expect, it } from "vitest";
import { choiceAllowed, defaultAllowed, restrictAllowed } from "./allowed";
import { mockDesign } from "./engine-mock";
import { EMPTY_LOCKS, type DesignResponse } from "./types";
import { EXAMPLE_DESIGN_REQUEST } from "./engine";

function design(): DesignResponse {
  const d = mockDesign({ installer: "x", home: EXAMPLE_DESIGN_REQUEST.home, locks: EMPTY_LOCKS });
  d.design.pv = { ...d.design.pv, include: true, kwp: 10.35, alternatives: [{ kwp: 6.3, share: 0.2 }, { kwp: 11.7, share: 0.2 }] };
  d.design.battery = { ...d.design.battery, include: true, kwh: 10, alternatives: [{ kwh: 5, share: 0.1 }, { kwh: 15, share: 0.1 }] };
  d.design.wallbox = { ...d.design.wallbox, include: true };
  d.design.heatpump = { ...d.design.heatpump, include: false };
  d.options = { ...d.options, heatpump: { available: true, kw: 10.5 } as never };
  return d;
}
const vals = (a: ReturnType<typeof defaultAllowed>, c: string) => a.find((x) => x.component === c)?.values;

describe("defaultAllowed", () => {
  it("offers the engine's alternatives, none / with, on / off", () => {
    const a = defaultAllowed(design());
    expect(vals(a, "pv")).toEqual([6.3, 10.35, 11.7]);
    expect(vals(a, "battery")).toEqual([0, 5, 10, 15]);
    expect(vals(a, "wallbox")).toEqual([true, false]);
    expect(vals(a, "heatpump")).toEqual([false, true]);
  });
});

describe("restrictAllowed", () => {
  it("keeps only what the installer ticked, always with the design's own value", () => {
    const a = restrictAllowed([{ component: "battery", values: [15] }, { component: "pv", values: [] }], design());
    expect(vals(a, "battery")).toEqual([10, 15]);
    expect(vals(a, "pv")).toEqual([10.35]);
    expect(vals(a, "wallbox")).toEqual([true]); // left out → fixed
    expect(vals(a, "heatpump")).toEqual([false]);
  });

  it("never lets the installer add a size the engine did not offer", () => {
    const a = restrictAllowed([{ component: "battery", values: [30, 15] }, { component: "pv", values: [99] }], design());
    expect(vals(a, "battery")).toEqual([10, 15]);
    expect(vals(a, "pv")).toEqual([10.35]);
  });

  it("reads shares stored before pv / heat pump as before (heat pump option allowed)", () => {
    const a = restrictAllowed([{ component: "battery", values: [0, 5, 10, 15] }, { component: "wallbox", values: [true, false] }], design());
    expect(vals(a, "battery")).toEqual([0, 5, 10, 15]);
    expect(vals(a, "heatpump")).toEqual([false, true]);
    expect(vals(a, "pv")).toEqual([10.35]);
  });

  it("follows a design that changed after sharing", () => {
    const d = design();
    d.design.battery.kwh = 15;
    d.design.battery.alternatives = [{ kwh: 10, share: 0.2 }, { kwh: 20, share: 0.1 }];
    const a = restrictAllowed([{ component: "battery", values: [10] }, { component: "pv", values: [] }], d);
    expect(vals(a, "battery")).toEqual([10, 15]);
  });
});

describe("choiceAllowed", () => {
  it("rejects anything outside the installer's choice", () => {
    const a = restrictAllowed([{ component: "battery", values: [15] }, { component: "heatpump", values: [true] }], design());
    expect(choiceAllowed(a, { battery_kwh: 15 })).toBe(true);
    expect(choiceAllowed(a, { battery_kwh: 5 })).toBe(false);
    expect(choiceAllowed(a, { wallbox: false })).toBe(false);
    expect(choiceAllowed(a, { heatpump: true })).toBe(true);
    expect(choiceAllowed(a, { pv_kwp: 11.7 })).toBe(false);
  });
});
