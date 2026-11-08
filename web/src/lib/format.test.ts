import { describe, expect, it } from "vitest";
import { fmtEur, fmtInt, fmtKwp, fmtPct, fmtRelative, fmtSize } from "./format";

describe("format", () => {
  it("groups thousands and rounds", () => {
    expect(fmtInt(4500)).toBe("4,500");
    expect(fmtInt(10349.6)).toBe("10,350");
  });
  it("kWp always has one decimal", () => {
    expect(fmtKwp(10.35)).toBe("10.35"); // packages are 0.45 kWp steps: 11.25, 8.55, 6.75 must not round
    expect(fmtKwp(11.25)).toBe("11.25");
    expect(fmtKwp(10.8)).toBe("10.8");
    expect(fmtKwp(9)).toBe("9.0");
  });
  it("percent from a 0..1 share", () => {
    expect(fmtPct(0.617)).toBe("62");
  });
  it("euros without cents", () => {
    expect(fmtEur(18450.4)).toBe("€18,450");
  });
  it("component sizes with unit", () => {
    expect(fmtSize("pv", 10.35)).toBe("10.35 kWp");
    expect(fmtSize("battery", 10)).toBe("10 kWh");
    expect(fmtSize("heatpump", 8)).toBe("8 kW");
    expect(fmtSize("battery", null)).toBe("None");
  });
  it("relative time", () => {
    const now = new Date("2026-11-07T18:00:00Z").getTime();
    expect(fmtRelative("2026-11-07T17:56:00Z", now)).toBe("4 min");
    expect(fmtRelative("2026-11-07T17:00:00Z", now)).toBe("1 h");
    expect(fmtRelative("2026-11-06T12:00:00Z", now)).toBe("Yesterday");
    expect(fmtRelative("2026-11-07T17:59:50Z", now)).toBe("now");
  });
});
