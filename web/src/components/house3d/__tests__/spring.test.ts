import { describe, expect, it } from "vitest";
import { LAND, SETTLE, stepSpring, type SpringState } from "../spring";

function run(cfg = SETTLE, seconds = 2, dt = 1 / 60) {
  const s: SpringState = { x: 0, v: 0 };
  let max = 0;
  for (let t = 0; t < seconds; t += dt) {
    stepSpring(s, 1, dt, cfg);
    max = Math.max(max, s.x);
  }
  return { s, max };
}

describe("stepSpring", () => {
  it("critically damped settles on the target without overshoot", () => {
    const { s, max } = run(SETTLE);
    expect(s.x).toBe(1);
    expect(max).toBeLessThanOrEqual(1 + 1e-6);
  });

  it("the landing spring overshoots a little, then settles", () => {
    const { s, max } = run(LAND);
    expect(max).toBeGreaterThan(1.01);
    expect(max).toBeLessThan(1.12);
    expect(s.x).toBe(1);
  });

  it("stays stable with long frames (tab switch)", () => {
    const { s } = run(SETTLE, 2, 0.5);
    expect(Number.isFinite(s.x)).toBe(true);
    expect(Math.abs(s.x - 1)).toBeLessThan(0.05);
  });

  it("keeps velocity when the target changes mid-flight", () => {
    const s: SpringState = { x: 0, v: 0 };
    for (let i = 0; i < 6; i++) stepSpring(s, 1, 1 / 60, SETTLE);
    const v = s.v;
    stepSpring(s, 0, 1 / 60, SETTLE);
    expect(v).toBeGreaterThan(0);
    expect(s.v).toBeGreaterThan(0); // still moving towards 1 for a moment, no hard cut
  });
});
