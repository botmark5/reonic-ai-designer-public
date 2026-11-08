import { describe, expect, it } from "vitest";
import { MAY_DAY, sunDirection, sunLight, sunPosition } from "../sun";

const at = (h: number) => sunPosition(h, MAY_DAY);

describe("sunPosition (Munich, mid-May, CEST)", () => {
  it("peaks around 61° due south shortly after 13:00", () => {
    let best = { h: 0, el: -90, az: 0 };
    for (let h = 6; h <= 22; h += 0.05) {
      const p = at(h);
      if (p.elevationDeg > best.el) best = { h, el: p.elevationDeg, az: p.azimuthDeg };
    }
    expect(best.el).toBeGreaterThan(59);
    expect(best.el).toBeLessThan(62.5);
    expect(best.az).toBeGreaterThan(175);
    expect(best.az).toBeLessThan(185);
    expect(best.h).toBeGreaterThan(12.9);
    expect(best.h).toBeLessThan(13.5);
  });

  it("rises in the east-north-east before 06:00 and sets in the west-north-west before 21:30", () => {
    expect(at(6).elevationDeg).toBeGreaterThan(0);
    expect(at(6).elevationDeg).toBeLessThan(10);
    expect(at(6).azimuthDeg).toBeGreaterThan(60);
    expect(at(6).azimuthDeg).toBeLessThan(90);
    expect(at(21.5).elevationDeg).toBeLessThan(0);
    expect(at(20).azimuthDeg).toBeGreaterThan(270);
  });
});

describe("sunDirection", () => {
  it("points up and south at noon, east in the morning (+x east, +z south)", () => {
    const noon = sunDirection({ elevationDeg: 60, azimuthDeg: 180 });
    expect(noon.y).toBeCloseTo(Math.sin((60 * Math.PI) / 180), 6);
    expect(noon.z).toBeGreaterThan(0);
    expect(Math.abs(noon.x)).toBeLessThan(1e-9);
    expect(sunDirection({ elevationDeg: 10, azimuthDeg: 90 }).x).toBeGreaterThan(0.9);
  });
});

describe("sunLight", () => {
  it("is warm and low near the horizon, neutral and strong at midday, off at night", () => {
    const dawn = sunLight(3);
    const noon = sunLight(55);
    const night = sunLight(-8);
    expect(night.intensity).toBe(0);
    expect(noon.intensity).toBeGreaterThan(dawn.intensity);
    // warmer = less blue relative to red
    expect(dawn.color.b / dawn.color.r).toBeLessThan(noon.color.b / noon.color.r);
  });
});
