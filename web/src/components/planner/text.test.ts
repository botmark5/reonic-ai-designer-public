import { describe, expect, it } from "vitest";
import { cardReasons, homeTitle } from "./text";

describe("cardReasons", () => {
  it("drops a clause repeated inside one reason", () => {
    const r = cardReasons([
      "Main drivers: the planned PV size (11.2 kWp) speaks for 10 kWh; the installer's catalogue speaks for 10 kWh; the installer's catalogue speaks for 10 kWh.",
    ]);
    expect(r.shown).toEqual(["Main drivers: the planned PV size (11.2 kWp) speaks for 10 kWh; the installer's catalogue speaks for 10 kWh."]);
  });

  it("drops a reason whose clauses all appeared earlier, ignoring case and the final period", () => {
    const r = cardReasons(["Typical size; range 10-15 kWh.", "range 10-15 kWh", "Another one."]);
    expect(r.shown).toEqual(["Typical size; range 10-15 kWh.", "Another one."]);
    expect(r.more).toEqual([]);
  });

  it("shows at most two by default and keeps the rest for 'more'", () => {
    const r = cardReasons(["a", "b", "c", "d"]);
    expect(r.shown).toEqual(["a", "b"]);
    expect(r.more).toEqual(["c", "d"]);
  });

  it("removes the [mock] tag and empty reasons", () => {
    expect(cardReasons(["[mock] Typical size", "  "]).shown).toEqual(["Typical size"]);
  });
});

describe("homeTitle", () => {
  it("uses the customer name", () => {
    expect(homeTitle({ customer_name: "Weber", address: "Hauptstr. 1, Augsburg", source: "voice" })).toBe("Weber");
  });
  it("falls back to the address when the call has no name", () => {
    expect(homeTitle({ customer_name: null, address: "Hauptstr. 1, Augsburg", source: "voice" })).toBe("Hauptstr. 1, Augsburg");
    expect(homeTitle({ customer_name: "  ", address: "Hauptstr. 1", source: "planner" })).toBe("Hauptstr. 1");
  });
  it("names a nameless call draft as one, and only blank manual homes 'Unnamed home'", () => {
    expect(homeTitle({ customer_name: null, address: null, source: "voice" })).toBe("Draft from a call");
    expect(homeTitle({ customer_name: null, address: "", source: "planner" })).toBe("Unnamed home");
  });
});

describe("altLabel", () => {
  it("names each alternative smaller or larger than the proposal", async () => {
    const { altLabel } = await import("./text");
    expect(altLabel(10.35, { kwp: 6.3, share: 0.2 })).toEqual({ label: "Smaller 6.3 kWp", title: "20 % of similar homes got this size" });
    expect(altLabel(10.35, { kwp: 11.7 })).toEqual({ label: "Larger 11.7 kWp", title: undefined });
    expect(altLabel(10.35, { kwp: 11.25, share: 0.31 }).label).toBe("Larger 11.25 kWp");
  });
});

describe("otherSizes", () => {
  it("lists the installer's catalogue sizes not already offered, ascending, without zero or junk", async () => {
    const { otherSizes } = await import("./text");
    expect(otherSizes([0, 7, 10, 14], [30, 5, 7, 10, 14, 15, 0, -1, Number.NaN, 20])).toEqual([5, 15, 20, 30]);
    expect(otherSizes([0, 10], undefined)).toEqual([]);
    expect(otherSizes([0, 9.2], [9.2000001, 25])).toEqual([25]);
  });
});
