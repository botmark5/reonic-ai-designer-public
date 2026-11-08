import { describe, expect, it } from "vitest";
import { changesLabel, inputChanges, refineSummary } from "./refine-text";

describe("inputChanges", () => {
  it("lists only facts that changed, in plain words", () => {
    expect(inputChanges({ has_ev: true, ev_km_year: 15000, annual_kwh: 4800 }, { has_ev: true, ev_km_year: 30000, annual_kwh: 4800 })).toEqual([
      "car 30,000 km a year",
    ]);
    expect(inputChanges({ has_ev: false }, { has_ev: true })).toEqual(["electric car: yes"]);
  });
});

describe("changesLabel", () => {
  it("reads like a sentence, not raw keys", () => {
    expect(changesLabel({ has_ev: true, ev_km_year: 30000 })).toBe("Updating electric car: yes, car 30,000 km a year");
  });
});

describe("refineSummary", () => {
  it("never says nothing changed when an input changed", () => {
    const s = refineSummary({ text: "Nothing changed: the home already has an EV.", inputs: ["car 30,000 km a year"], designLines: [] });
    expect(s).toBe("Updated car 30,000 km a year. The sizes stay the same.");
  });
  it("keeps Claude's sentence otherwise", () => {
    expect(refineSummary({ text: "Battery removed as asked.", inputs: [], designLines: ["Battery 10 → none"] })).toBe("Battery removed as asked.");
  });
  it("builds a line from the facts when there is no sentence", () => {
    expect(refineSummary({ text: "", inputs: ["electric car: yes"], designLines: ["Wallbox none → 11 kW"] })).toBe(
      "Updated electric car: yes. New design: Wallbox none → 11 kW.",
    );
    expect(refineSummary({ text: "", inputs: [], designLines: [] })).toBe("Nothing in this note changes the home or the design.");
  });
});
