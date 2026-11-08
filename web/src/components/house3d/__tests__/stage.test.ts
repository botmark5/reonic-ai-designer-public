import { describe, expect, it } from "vitest";
import { modelReason, stageRoof, tilesForced, tilesWanted } from "../stage";

describe("stageRoof", () => {
  it("passes the roof through without a location", () => {
    expect(stageRoof({ pitchDeg: 30 }, undefined)).toEqual({ pitchDeg: 30 });
    expect(stageRoof(undefined, undefined)).toBeUndefined();
  });
  it("uses the location for the sun when the roof has no coordinates", () => {
    expect(stageRoof({ pitchDeg: 30 }, { lat: 52.5, lng: 13.4 })).toEqual({ pitchDeg: 30, latitude: 52.5, longitude: 13.4 });
  });
  it("keeps the roof's own coordinates", () => {
    expect(stageRoof({ latitude: 48, longitude: 11 }, { lat: 52.5, lng: 13.4 })).toEqual({ latitude: 48, longitude: 11 });
  });
  it("ignores a broken location", () => {
    expect(stageRoof(undefined, { lat: Number.NaN, lng: 13 })).toBeUndefined();
  });
});

describe("tilesWanted", () => {
  it("is off by default", () => expect(tilesWanted("", undefined)).toBe(false));
  it("turns on with ?tiles=1 or the env flag", () => {
    expect(tilesWanted("?tiles=1", undefined)).toBe(true);
    expect(tilesWanted("?a=b", "1")).toBe(true);
  });
  it("?tiles=0 wins over the env flag", () => expect(tilesWanted("?tiles=0", "1")).toBe(false));
});

import { revealed, revealFlows } from "../stage";

describe("revealed", () => {
  it("shows everything without a reveal", () => {
    const { warm, ...rest } = revealed(undefined);
    expect(warm).toBe(false);
    expect(Object.values(rest).every(Boolean)).toBe(true);
  });
  it("hides everything at the start of a build-up", () => {
    expect(Object.values(revealed({})).some(Boolean)).toBe(false);
  });
  it("needs the shell before the roof and the roof before panels", () => {
    expect(revealed({ roof: true, panels: true })).toMatchObject({ roof: false, panels: false });
    expect(revealed({ shell: true, panels: true })).toMatchObject({ shell: true, roof: false, panels: false });
    expect(revealed({ shell: true, roof: true, panels: true })).toMatchObject({ panels: true, car: false });
  });
});

describe("revealFlows", () => {
  const flows = [
    { id: "sun-panels", path: ["sun", "panels"], kw: 3 },
    { id: "grid-house", path: ["grid", "house"], kw: 1 },
    { id: "panels-car", path: ["panels", "inverter", "wallbox", "car"], kw: 2 },
  ] as const;
  it("keeps only flows whose parts are on stage", () => {
    const shown = revealed({ shell: true, roof: true });
    expect(revealFlows([...flows].map((f) => ({ ...f, path: [...f.path] })), shown).map((f) => f.id)).toEqual(["grid-house"]);
    const all = revealed(undefined);
    expect(revealFlows([...flows].map((f) => ({ ...f, path: [...f.path] })), all)).toHaveLength(3);
  });
});

import { revealedFromKey, revealKey } from "../stage";
describe("revealKey", () => {
  it("round-trips", () => {
    expect(revealKey(undefined)).toBe("");
    expect(revealedFromKey("")).toEqual(revealed(undefined));
    const r = { shell: true, roof: true, car: true };
    expect(revealedFromKey(revealKey(r))).toEqual(revealed(r));
  });
});

describe("reveal defaults for inverter, battery and existing PV", () => {
  it("inverter comes with the first panels, battery and existing PV with the new panels", () => {
    expect(revealed({ shell: true, roof: true, panels: true })).toMatchObject({ inverter: true, battery: true, existingPv: true, pv: true });
  });
  it("a retrofit: existing PV first, then the battery on its own", () => {
    const r = revealed({ shell: true, roof: true, existingPv: true });
    expect(r).toMatchObject({ existingPv: true, panels: false, pv: true, inverter: true, battery: false });
    expect(revealed({ shell: true, roof: true, existingPv: true, battery: true }).battery).toBe(true);
  });
  it("explicit false wins over the default", () => {
    expect(revealed({ shell: true, roof: true, panels: true, inverter: false }).inverter).toBe(false);
  });
  it("the key keeps 'not given' apart from false", () => {
    const r = { shell: true, roof: true, panels: true, inverter: false };
    expect(revealedFromKey(revealKey(r))).toEqual(revealed(r));
    expect(revealedFromKey(revealKey({ shell: true, roof: true, panels: true })).inverter).toBe(true);
  });
});

import { staticWanted } from "../stage";
describe("warm and static", () => {
  it("warm only in a build-up, after the shell", () => {
    expect(revealed(undefined).warm).toBe(false);
    expect(revealed({ warm: true }).warm).toBe(false);
    expect(revealed({ shell: true, warm: true }).warm).toBe(true);
    expect(revealedFromKey(revealKey({ shell: true, warm: true })).warm).toBe(true);
  });
  it("?static=1 forces the still", () => {
    expect(staticWanted("?static=1")).toBe(true);
    expect(staticWanted("?static=0")).toBe(false);
  });
});

describe("modelReason (the /visit progress step)", () => {
  const base = { outside: true, tiles: false, still: false, wanted: true, key: true, at: "48,11", failed: null };
  it("is null while the street is on or the Inside view shows", () => {
    expect(modelReason({ ...base, tiles: true })).toBeNull();
    expect(modelReason({ ...base, outside: false })).toBeNull();
  });
  it("names why the model is the outside", () => {
    expect(modelReason({ ...base, still: true })).toBe("static");
    expect(modelReason({ ...base, wanted: false })).toBe("off");
    expect(modelReason({ ...base, key: false })).toBe("no key");
    expect(modelReason({ ...base, at: null })).toBe("no location");
    expect(modelReason({ ...base, failed: "tiles: slow" })).toBe("tiles: slow");
    expect(modelReason(base)).toBe("street unavailable");
  });
});

describe("drawn model by default (Mark: tiles too blurry)", () => {
  const base = { outside: true, tiles: false, still: false, wanted: true, key: true, at: "48,11", failed: null };
  it("says 'model' when the street is offered but not chosen", () => {
    expect(modelReason({ ...base, chosen: false })).toBe("model");
    expect(modelReason({ ...base, chosen: false, failed: "tiles: slow" })).toBe("tiles: slow");
  });
  it("only ?tiles=1 opens on the street", () => {
    expect(tilesForced("?tiles=1")).toBe(true);
    expect(tilesForced("")).toBe(false);
  });
});
