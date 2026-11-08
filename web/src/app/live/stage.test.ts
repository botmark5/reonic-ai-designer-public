import { describe, expect, it } from "vitest";
import { mockDesign } from "@/lib/engine-mock";
import { EMPTY_LOCKS, type DesignResponse } from "@/lib/types";
import { callToLive, factsToHome, heardTurns, nextHeardOrder, type Facts } from "./facts";
import { EMPTY_DESIGN, REVEAL_ORDER, revealFromFacts, stagedDesign, stepToward, type LiveReveal } from "./stage";

const draftFor = (f: Facts): DesignResponse => mockDesign({ installer: "installer_a", home: factsToHome(f), locks: EMPTY_LOCKS });
const NONE: LiveReveal = { shell: false, warm: false, panels: false, battery: false, car: false, heatpump: false };

describe("revealFromFacts: each fact maps to one visible change", () => {
  it("idle (no call): only the house shell", () => {
    expect(revealFromFacts({}, null, false)).toEqual(NONE);
    expect(revealFromFacts({}, null, true)).toEqual({ ...NONE, shell: true });
  });
  it("yearly use (or the bill) warms the house up", () => {
    expect(revealFromFacts({ annual_kwh: 4800 }, null, true).warm).toBe(true);
    expect(revealFromFacts({ monthly_bill_eur: 120 }, null, true).warm).toBe(true);
    expect(revealFromFacts({ household: 4 }, null, true).warm).toBe(false);
  });
  it("first draft drops the panels; battery follows the engine's battery", () => {
    const f: Facts = { annual_kwh: 4800, has_existing_pv: false };
    const r = revealFromFacts(f, draftFor(f), true);
    expect(r.panels).toBe(true);
    expect(r.battery).toBe(true);
  });
  it("no panels or battery before there is a draft, even if facts are complete", () => {
    const r = revealFromFacts({ annual_kwh: 4800, has_ev: true, heating: "gas" }, null, true);
    expect(r.panels).toBe(false);
    expect(r.battery).toBe(false);
    expect(r.car).toBe(false);
  });
  it("an engine design without a battery never shows one", () => {
    const f: Facts = { annual_kwh: 4800 };
    const d = draftFor(f);
    d.design.battery = { ...d.design.battery, include: false, kwh: null };
    expect(revealFromFacts(f, d, true).battery).toBe(false);
  });
  it("EV: the car drives in when the re-draft adds a wallbox, and only then", () => {
    const ev: Facts = { annual_kwh: 4800, has_ev: true, ev_km_year: 15000 };
    expect(revealFromFacts(ev, draftFor(ev), true).car).toBe(true);
    const noEv: Facts = { annual_kwh: 4800, has_ev: false };
    expect(revealFromFacts(noEv, draftFor(noEv), true).car).toBe(false);
    const d = draftFor(ev);
    d.design.wallbox = { ...d.design.wallbox, include: false, kw: null };
    expect(revealFromFacts(ev, d, true).car).toBe(false);
  });
  it("gas or oil heating shows the heat pump option; a heat pump already there does not", () => {
    expect(revealFromFacts({ heating: "gas" }, null, true).heatpump).toBe(true);
    expect(revealFromFacts({ heating: "oil" }, null, true).heatpump).toBe(true);
    expect(revealFromFacts({ heating: "Gas boiler" }, null, true).heatpump).toBe(true);
    expect(revealFromFacts({ heating: "heat_pump" }, null, true).heatpump).toBe(false);
    expect(revealFromFacts({}, null, true).heatpump).toBe(false);
  });
  it("a design that includes a heat pump shows it regardless of the heating", () => {
    const f: Facts = { annual_kwh: 4800 };
    const d = draftFor(f);
    d.design.heatpump = { ...d.design.heatpump, include: true, kw: 10.5 };
    expect(revealFromFacts(f, d, true).heatpump).toBe(true);
  });
});

describe("stagedDesign: the house shows only what has been revealed, sizes untouched", () => {
  const f: Facts = { annual_kwh: 4800, has_ev: true, ev_km_year: 15000 };
  const d = draftFor(f);
  it("hides components not yet revealed by switching include off, never by changing a size", () => {
    const s = stagedDesign(d, { ...NONE, shell: true, warm: true, panels: true });
    expect(s.design.pv).toEqual(d.design.pv);
    expect(s.design.battery.include).toBe(false);
    expect(s.design.battery.kwh).toBe(d.design.battery.kwh);
    expect(s.design.wallbox.include).toBe(false);
  });
  it("everything revealed = the engine's design exactly", () => {
    const s = stagedDesign(d, { shell: true, warm: true, panels: true, battery: true, car: true, heatpump: true });
    expect(s.design).toEqual(d.design);
  });
  it("without a draft it returns the empty house", () => {
    const s = stagedDesign(null, { ...NONE, shell: true });
    expect(s).toBe(EMPTY_DESIGN);
    expect(s.design.pv.include || s.design.battery.include || s.design.wallbox.include || s.design.heatpump.include).toBe(false);
  });
  it("does not mutate the engine response", () => {
    const before = JSON.stringify(d);
    stagedDesign(d, NONE);
    expect(JSON.stringify(d)).toBe(before);
  });
});

describe("stepToward: one new step at a time, removals at once", () => {
  it("adds the first missing step in build order", () => {
    const target: LiveReveal = { shell: true, warm: true, panels: true, battery: true, car: true, heatpump: false };
    let cur = NONE;
    const seen: string[] = [];
    for (let i = 0; i < 10; i++) {
      const next = stepToward(cur, target);
      if (next === cur) break;
      seen.push(REVEAL_ORDER.find((k) => next[k] !== cur[k])!);
      cur = next;
    }
    expect(seen).toEqual(["shell", "warm", "panels", "battery", "car"]);
    expect(cur).toEqual(target);
  });
  it("turns everything off in one go (restart, new call)", () => {
    const all: LiveReveal = { shell: true, warm: true, panels: true, battery: true, car: true, heatpump: true };
    expect(stepToward(all, NONE)).toEqual(NONE);
  });
  it("returns the same object when nothing changes (no re-render)", () => {
    const cur = { ...NONE, shell: true };
    expect(stepToward(cur, { ...cur })).toBe(cur);
  });
});

describe("factsToHome keeps its semantics", () => {
  it("bill → rounded kWh, EV default 15,000 km, default 4,000 kWh", () => {
    expect(factsToHome({ monthly_bill_eur: 120 }).annual_kwh).toBe(4100);
    expect(factsToHome({ has_ev: true }).ev_km_year).toBe(15000);
    expect(factsToHome({}).annual_kwh).toBe(4000);
    expect(factsToHome({ annual_kwh: 4800 }).demand_is_default).toBe(false);
    expect(factsToHome({ heating: "gas", roof_type: "concrete_tile" })).toMatchObject({ heating: "Gas", roof_type: "Concrete tile" });
    expect(factsToHome({ existing_pv_kwp: 8 }).has_existing_pv).toBe(true);
  });
});

describe("callToLive: a calls row from update_facts → chips, engine home, location", () => {
  const row = {
    customer_name: "Anna Weber",
    address: "Musterstraße 1, 80331 München",
    facts: {
      annual_kwh: 4250, inhabitants: 4, has_ev: true, ev_km_year: 15000, has_existing_pv: false, existing_pv_kwp: null,
      existing_battery_kwh: null, heating: "Gas", roof_type: "clay_tile", load_profile: "H0", orientation_deg: 214, tilt_deg: 32,
      demand_is_default: false, price_eur_kwh: null, house_sqm: null, heating_demand_kwh: null,
      stated: { household: "family of four", has_ev: "planned" },
      voice: { customer_name: "Anna Weber", household: 4, has_ev: true, ev_km_year: null, heating: "gas", annual_kwh: null, has_existing_pv: false },
      assumptions: ["Annual use estimated from household size (4 people): 4250 kWh."],
      updated_fields: ["household"],
      facts_updated_at: "2026-11-08T02:09:34.613Z",
      solar: { status: "ok", lat: 48.17, lng: 11.59 },
      conversation_id: "conv_x",
    },
  };
  it("chips come from the caller's answers (voice), with the row's name and address", () => {
    const l = callToLive(row);
    expect(l.facts).toMatchObject({ customer_name: "Anna Weber", address: "Musterstraße 1, 80331 München", household: 4, has_ev: true, heating: "gas" });
    expect(l.facts.annual_kwh_estimate).toBe(4250); // derived from the household, shown as an estimate
    expect(revealFromFacts(l.facts, null, true).warm).toBe(true);
  });
  it("the engine gets d-voice's derived home (same as create_design), without the bookkeeping keys", () => {
    const l = callToLive(row);
    expect(l.home).toMatchObject({ annual_kwh: 4250, inhabitants: 4, has_ev: true, heating: "Gas", orientation_deg: 214, tilt_deg: 32 });
    for (const k of ["stated", "voice", "assumptions", "updated_fields", "facts_updated_at", "solar", "conversation_id"]) expect(l.home).not.toHaveProperty(k);
  });
  it("the caller's display answers d-voice also writes at the top level never reach the engine", () => {
    const l = callToLive({ ...row, facts: { ...row.facts, customer_name: "Anna Weber", household: 4, monthly_bill_eur: 120, roof_direction: "south", heating_age_years: 15 } });
    for (const k of ["customer_name", "household", "monthly_bill_eur", "roof_direction", "heating_age_years"]) expect(l.home).not.toHaveProperty(k);
    expect(l.home.annual_kwh).toBe(4250);
  });
  it("ready to draft once the derived home has a yearly use", () => {
    expect(callToLive(row).ready).toBe(true);
    expect(callToLive({ ...row, facts: { voice: { customer_name: "A" } } }).ready).toBe(false);
  });
  it("Google's roof lookup gives the stage its location", () => {
    expect(callToLive(row).location).toEqual({ lat: 48.17, lng: 11.59, address: "Musterstraße 1, 80331 München" });
    expect(callToLive({ ...row, facts: { ...row.facts, solar: undefined } }).location).toBeUndefined();
  });
  it("the update time is passed through for latency measurement", () => {
    expect(callToLive(row).updatedAt).toBe("2026-11-08T02:09:34.613Z");
  });
  it("an older row (facts = VoiceFacts, no voice key) still works through factsToHome", () => {
    const l = callToLive({ customer_name: null, address: null, facts: { annual_kwh: 4800, household: 4, has_ev: false } as never });
    expect(l.facts.household).toBe(4);
    expect(l.home).toEqual(factsToHome({ annual_kwh: 4800, household: 4, has_ev: false }));
    expect(l.ready).toBe(true);
  });
});

describe("d-voice review: a real call only drafts once the caller said a consumption fact", () => {
  // the exact shape update_facts writes after the name alone: annual_kwh = 4,000 default, demand_is_default true
  const nameOnly = {
    customer_name: "Anna Weber", address: null,
    facts: { annual_kwh: 4000, demand_is_default: true, has_ev: false, load_profile: "H0", voice: { customer_name: "Anna Weber", annual_kwh: null, household: null, monthly_bill_eur: null } },
  };
  it("name only: not ready, no estimate chip, no warm windows", () => {
    const l = callToLive(nameOnly);
    expect(l.ready).toBe(false);
    expect(l.facts.annual_kwh_estimate).toBeNull();
    expect(revealFromFacts(l.facts, null, true).warm).toBe(false);
  });
  it("household said → ready with an estimate; kWh said → ready; bill said → ready", () => {
    const withHh = { ...nameOnly, facts: { ...nameOnly.facts, annual_kwh: 4250, voice: { ...nameOnly.facts.voice, household: 4 } } };
    expect(callToLive(withHh).ready).toBe(true);
    expect(callToLive(withHh).facts.annual_kwh_estimate).toBe(4250);
    const kwh = { ...nameOnly, facts: { ...nameOnly.facts, annual_kwh: 4800, voice: { ...nameOnly.facts.voice, annual_kwh: 4800 } } };
    expect(callToLive(kwh).ready).toBe(true);
    expect(callToLive(kwh).facts.annual_kwh_estimate).toBeNull();
    const bill = { ...nameOnly, facts: { ...nameOnly.facts, voice: { ...nameOnly.facts.voice, monthly_bill_eur: 120 } } };
    expect(callToLive(bill).ready).toBe(true);
  });
  it("a roof looked up for an earlier address is not used after the caller corrects it", () => {
    const base = { customer_name: null, address: "Neue Straße 2, Augsburg", facts: { annual_kwh: 4800, voice: { annual_kwh: 4800 }, solar: { status: "ok", lat: 48.1, lng: 11.5 } } };
    expect(callToLive({ ...base, facts: { ...base.facts, solar_for: "Alte Straße 1, Augsburg" } }).location).toBeUndefined();
    expect(callToLive({ ...base, facts: { ...base.facts, solar_for: "Neue Straße 2, Augsburg" } }).location).toMatchObject({ lat: 48.1 });
    expect(callToLive(base).location).toMatchObject({ lat: 48.1 }); // older rows without solar_for
    expect(callToLive({ ...base, facts: { ...base.facts, solar_for: "Alte Straße 1, Augsburg" } }).solar).toBeUndefined();
  });
});

describe("heardTurns: the caller's answers in the order they were given, labelled", () => {
  it("orders by arrival, labels each answer with its question", () => {
    const order = nextHeardOrder([], { household: "family of four", has_ev: "planned" }, ["has_ev"]);
    expect(order).toEqual(["household", "has_ev"]); // has_ev is this update: it was said last
    const turns = heardTurns({ household: "family of four", has_ev: "planned" }, order);
    expect(turns.map((t) => t.text)).toEqual(["Household: family of four", "Electric car: planned"]);
  });
  it("keeps the first order and appends new answers (this update's fields last: they were said most recently)", () => {
    const o1 = nextHeardOrder([], { address: "Marienplatz 1" }, ["address"]);
    const o2 = nextHeardOrder(o1, { address: "Marienplatz 1", has_existing_pv: "no", annual_kwh: "4800" }, ["annual_kwh"]);
    expect(o2).toEqual(["address", "has_existing_pv", "annual_kwh"]);
    expect(nextHeardOrder(o2, { address: "x" }, [])).toBe(o2); // nothing new: same array
  });
  it("skips empty values", () => {
    expect(heardTurns({ a: "", b: null, household: 4 }, ["a", "b", "household"]).map((t) => t.text)).toEqual(["Household: 4"]);
  });
});
