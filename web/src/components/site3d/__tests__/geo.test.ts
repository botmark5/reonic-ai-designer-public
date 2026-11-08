import { describe, expect, it } from "vitest";
import { downslope, faceRaise, dropOrder, median, panelPose, panelView, toScene } from "../geo";

const size = { width_m: 1.045, height_m: 1.879 };
const seg = (az: number, pitch = 30) => ({ pitch_deg: pitch, azimuth_deg: az, center: { lat: 0, lng: 0, x_m: 0, y_m: 0 } });

describe("axes", () => {
  it("east is +x, north is -z", () => expect(toScene(3, 4)).toEqual([3, -4]));
  it("a south roof slopes down to +z, an east roof to +x", () => {
    const [sx, sz] = downslope(180);
    expect(sx).toBeCloseTo(0);
    expect(sz).toBeCloseTo(1);
    const [ex, ez] = downslope(90);
    expect(ex).toBeCloseTo(1);
    expect(ez).toBeCloseTo(0);
  });
});

describe("panelPose", () => {
  it("panels south of the centre on a south roof sit lower", () => {
    const low = panelPose({ x_m: 0, y_m: -2, orientation: "LANDSCAPE" }, seg(180), 10, size);
    expect(low.z).toBe(2);
    expect(low.y).toBeCloseTo(10 - 2 * Math.tan(Math.PI / 6));
    const high = panelPose({ x_m: 0, y_m: 2, orientation: "LANDSCAPE" }, seg(180), 10, size);
    expect(high.y).toBeGreaterThan(10);
  });
  it("sideways along the eave keeps the height", () => {
    expect(panelPose({ x_m: 5, y_m: 0, orientation: "PORTRAIT" }, seg(180), 10, size).y).toBeCloseTo(10);
  });
  it("landscape puts the long side across the slope", () => {
    expect(panelPose({ x_m: 0, y_m: 0, orientation: "LANDSCAPE" }, seg(180), 0, size)).toMatchObject({ across: 1.879, along: 1.045 });
    expect(panelPose({ x_m: 0, y_m: 0, orientation: "PORTRAIT" }, seg(180), 0, size)).toMatchObject({ across: 1.045, along: 1.879 });
  });
  it("yaw turns +z towards the azimuth", () => {
    expect(panelPose({ x_m: 0, y_m: 0, orientation: "LANDSCAPE" }, seg(180), 0, size).yaw).toBeCloseTo(0);
    expect(panelPose({ x_m: 0, y_m: 0, orientation: "LANDSCAPE" }, seg(90), 0, size).yaw).toBeCloseTo(Math.PI / 2);
  });
});

describe("dropOrder", () => {
  it("eave row first, then up; best segment first", () => {
    const poses = [
      { x: 0, y: 11, z: 0 }, { x: 1, y: 10, z: 0 }, { x: 0, y: 10, z: 0 }, { x: 0, y: 5, z: 0 },
    ].map((p) => ({ ...p, yaw: 0, pitch: 0, across: 1, along: 1 }));
    expect(dropOrder(poses, [0, 0, 0, 1])).toEqual([2, 1, 0, 3]);
  });
});

describe("median", () => {
  it("ignores bad values", () => {
    expect(median([3, Number.NaN, 1, 2])).toBe(2);
    expect(median([])).toBeNull();
    expect(median([1, 2, 3, 10])).toBe(2.5);
  });
});

import { quantile, segmentHeights } from "../geo";
describe("segmentHeights", () => {
  it("calibrates one offset and ignores a segment under a tree", () => {
    const segs = [{ index: 0, plane_height_m: 540 }, { index: 1, plane_height_m: 538 }, { index: 2, plane_height_m: 541 }];
    const hits = new Map([[0, 587], [1, 585], [2, 600]]); // segment 2's ray hit a tree crown
    const { offset, heights } = segmentHeights(segs, hits, 47);
    expect(offset).toBe(47);
    expect(heights.get(2)).toBe(588);
  });
  it("falls back to the default offset without hits", () => {
    expect(segmentHeights([{ index: 0, plane_height_m: 500 }], new Map(), 47).heights.get(0)).toBe(547);
  });
  it("quantile", () => expect(quantile([5, 1, 3, 2, 4], 0.25)).toBe(2));
});

import { sunFrame, sunUv } from "../geo";
describe("sun map frame", () => {
  const local = { center: { x_m: 0, y_m: 0 }, width_m: 60, height_m: 60, rotation_deg: 0 };
  it("north edge is v = 1, east edge u = 1", () => {
    const f = sunFrame(local);
    const [u1, v1] = sunUv(f, 0, -30); // 30 m north
    expect(u1).toBeCloseTo(0.5);
    expect(v1).toBeCloseTo(1);
    const [u2, v2] = sunUv(f, 30, 0); // 30 m east
    expect(u2).toBeCloseTo(1);
    expect(v2).toBeCloseTo(0.5);
  });
  it("a clockwise grid rotation moves north-east points towards the top centre", () => {
    const f = sunFrame({ ...local, rotation_deg: 45 });
    const d = 30 / Math.SQRT2;
    const [u, v] = sunUv(f, d, -d); // 30 m towards north-east = straight "up" in a 45° rotated image
    expect(u).toBeCloseTo(0.5);
    expect(v).toBeCloseTo(1);
  });
});

describe("panelView", () => {
  const seg = (index: number, azimuth_deg: number) => ({ index, azimuth_deg, pitch_deg: 30, center: { lat: 0, lng: 0, x_m: 0, y_m: 0 } });
  const panel = (x_m: number, y_m: number, segment_index: number) => ({ x_m, y_m, segment_index, orientation: "PORTRAIT" as const });
  it("looks at the panels' centroid from the side they face", () => {
    const v = panelView({ segments: [seg(0, 225)] as never, panels: [panel(4, -2, 0), panel(6, -2, 0)] as never });
    expect(v.centre[0]).toBeCloseTo(5);
    expect(v.centre[1]).toBeCloseTo(2); // north −2 m → scene z +2
    // south-west facing: downhill towards −x (west) and +z (south)
    expect(v.facing![0]).toBeLessThan(0);
    expect(v.facing![1]).toBeGreaterThan(0);
    expect(Math.hypot(...v.facing!)).toBeCloseTo(1);
  });
  it("has no facing for panels on opposite faces or no panels", () => {
    expect(panelView({ segments: [seg(0, 90), seg(1, 270)] as never, panels: [panel(1, 0, 0), panel(-1, 0, 1)] as never }).facing).toBeNull();
    expect(panelView({ segments: [], panels: [] } as never)).toEqual({ centre: [0, 0], facing: null });
  });
});

describe("faceRaise", () => {
  it("raises a face by the upper quartile of how far the mesh sits above it, one value for all its panels", () => {
    expect(faceRaise([10, 10, 10, 10], [10.2, 10.8, 10.6, 10.4])).toBeCloseTo(0.6, 6); // nearest-rank upper quartile
  });
  it("never lowers, ignores misses and chimneys", () => {
    expect(faceRaise([10, 10], [9, 9.5])).toBe(0);
    expect(faceRaise([10, 10, 10], [Number.NaN, 15, undefined])).toBe(0);
    expect(faceRaise([], [])).toBe(0);
  });
});
