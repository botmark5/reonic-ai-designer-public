import { describe, expect, it } from "vitest";
import { PANEL, capacity, layoutPanels, panelCount, rowSizes, type RoofPlane } from "../layout";

const main: RoofPlane = { id: "main", width: 13, slope: 6.1, margin: { side: 0.4, eave: 0.4, ridge: 0.3 } };
const garage: RoofPlane = { id: "garage", width: 5.0, slope: 4.2, margin: { side: 0.3, eave: 0.3, ridge: 0.3 } };

describe("panelCount", () => {
  it("is round(kWp / 0.45), capped by maxPanels", () => {
    expect(panelCount(9.0)).toBe(20);
    expect(panelCount(10.8)).toBe(24);
    expect(panelCount(7.2)).toBe(16);
    expect(panelCount(null)).toBe(0);
    expect(panelCount(undefined)).toBe(0);
    expect(panelCount(0)).toBe(0);
    expect(panelCount(-3)).toBe(0);
    expect(panelCount(Number.NaN)).toBe(0);
    expect(panelCount(14.4, 25)).toBe(25);
  });
});

describe("capacity", () => {
  it("counts portrait panels inside the margins", () => {
    expect(capacity(main)).toEqual({ cols: 10, rows: 3, total: 30 });
  });
  it("is zero for a plane too small for one panel", () => {
    expect(capacity({ ...main, slope: 1.5 }).total).toBe(0);
  });
});

describe("layoutPanels", () => {
  it("places n panels in full rows from the eave, centred", () => {
    const l = layoutPanels(20, [main]);
    expect(l.placed).toBe(20);
    expect(l.overflow).toBe(0);
    const rows = new Set(l.slots.map((s) => s.v));
    expect(rows.size).toBe(2);
    const meanU = l.slots.reduce((a, s) => a + s.u, 0) / l.slots.length;
    expect(Math.abs(meanU)).toBeLessThan(1e-9);
    for (const a of l.slots)
      for (const b of l.slots)
        if (a !== b && a.v === b.v) expect(Math.abs(a.u - b.u)).toBeGreaterThanOrEqual(PANEL.w);
  });

  it("centres a partial last row", () => {
    const l = layoutPanels(13, [main]);
    const top = Math.max(...l.slots.map((s) => s.v));
    const last = l.slots.filter((s) => s.v === top);
    expect(last).toHaveLength(3);
    expect(Math.abs(last.reduce((a, s) => a + s.u, 0))).toBeLessThan(1e-9);
  });

  it("overflow spills to the garage, then is reported", () => {
    const capG = capacity(garage).total;
    const n = 30 + capG + 2;
    const l = layoutPanels(n, [main, garage]);
    expect(l.slots.filter((s) => s.plane === "main")).toHaveLength(30);
    expect(l.slots.filter((s) => s.plane === "garage")).toHaveLength(capG);
    expect(l.placed).toBe(30 + capG);
    expect(l.requested).toBe(n);
    expect(l.overflow).toBe(2);
  });

  it("respects margins for any slope", () => {
    for (const slope of [3.0, 6.1, 9.0]) {
      const plane = { ...main, slope };
      const l = layoutPanels(100, [plane]);
      expect(l.placed).toBe(capacity(plane).total);
      for (const s of l.slots) {
        expect(Math.abs(s.u) + PANEL.w / 2).toBeLessThanOrEqual(plane.width / 2 - plane.margin.side + 1e-9);
        expect(s.v - PANEL.h / 2).toBeGreaterThanOrEqual(plane.margin.eave - 1e-9);
        expect(s.v + PANEL.h / 2).toBeLessThanOrEqual(plane.slope - plane.margin.ridge + 1e-9);
      }
    }
  });

  it("keeps slot ids unique and stable as the system grows by full rows", () => {
    const a = layoutPanels(20, [main]).slots.map((s) => s.id);
    const b = layoutPanels(30, [main]).slots.map((s) => s.id);
    expect(new Set(b).size).toBe(b.length);
    for (const id of a) expect(b).toContain(id);
  });

  it("a panel keeps its id only if its position is unchanged", () => {
    const before = layoutPanels(13, [main]).slots; // last row: 3 panels, centred
    const after = layoutPanels(14, [main]).slots; // last row: 4 panels, shifted half a pitch
    const pos = new Map(after.map((s) => [s.id, s]));
    for (const s of before) {
      const same = pos.get(s.id);
      if (same) expect([same.u, same.v]).toEqual([s.u, s.v]);
    }
    expect(before.filter((s) => pos.has(s.id))).toHaveLength(10);
  });

  it("returns nothing for zero panels", () => {
    expect(layoutPanels(0, [main])).toEqual({ slots: [], requested: 0, placed: 0, overflow: 0 });
  });

  it("never leaves one or two panels alone on a last row (Mark: no islands)", () => {
    expect(rowSizes(21, 10)).toEqual([10, 6, 5]);
    expect(rowSizes(11, 10)).toEqual([6, 5]);
    expect(rowSizes(13, 10)).toEqual([10, 3]);
    expect(rowSizes(20, 10)).toEqual([10, 10]);
    expect(rowSizes(2, 10)).toEqual([2]);
    const top = (n: number) => { const l = layoutPanels(n, [main]); const v = Math.max(...l.slots.map((s) => s.v)); return l.slots.filter((s) => s.v === v).length; };
    expect(top(21)).toBeGreaterThan(2);
  });
});
