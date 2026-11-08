import { describe, expect, it } from "vitest";
import { normaliseFacts } from "@/lib/voice";
import { applyAnswer, canDraft, nextQuestion, progress, QUESTIONS, readNumber, readUsage, type Answers } from "./questions";

/** Click through the questions: `pick(question) → [facts, label]` or null to skip. */
function run(pick: (id: string) => Answers | null) {
  let a: Answers = {};
  const answered: string[] = [];
  const asked: string[] = [];
  for (let q = nextQuestion(answered, a); q; q = nextQuestion(answered, a)) {
    asked.push(q.id);
    const set = pick(q.id);
    if (set) a = applyAnswer(a, set);
    answered.push(q.id);
  }
  return { a, asked };
}
const choice = (id: string, label: string) => QUESTIONS.find((q) => q.id === id)!.choices.find((c) => c.label === label)!.set;

describe("intake question flow", () => {
  it("asks in the voice agent's order: name, address, existing solar, household, use, EV, heating, roof", () => {
    const { asked } = run(() => null);
    expect(asked).toEqual(["name", "address", "existing_pv", "household", "usage", "ev", "heating", "roof_direction"]);
  });

  it("asks follow-ups only when they apply (solar size, EV km)", () => {
    const { asked } = run((id) => (id === "existing_pv" ? choice(id, "Yes") : id === "ev" ? choice(id, "Planned (next year)") : null));
    expect(asked).toContain("existing_pv_kwp");
    expect(asked).toContain("ev_km");
    expect(asked.indexOf("existing_pv_kwp")).toBe(asked.indexOf("existing_pv") + 1);
    expect(asked.indexOf("ev_km")).toBe(asked.indexOf("ev") + 1);
    // a size typed into "Other" on the solar question answers the follow-up too
    const other = QUESTIONS.find((q) => q.id === "existing_pv")!.other!.read("8 kWp")!;
    expect(run((id) => (id === "existing_pv" ? other : null)).asked).not.toContain("existing_pv_kwp");
  });

  it("the stage persona through the voice agent's mapping: same home as the call (Anna Weber)", () => {
    const { a } = run((id) => {
      if (id === "name") return { customer_name: "Anna Weber" };
      if (id === "address") return QUESTIONS[1].choices[0].set;
      if (id === "existing_pv") return choice(id, "No");
      if (id === "household") return choice(id, "4");
      if (id === "usage") return choice(id, "€120 / month");
      if (id === "ev") return choice(id, "Planned (next year)");
      if (id === "heating") return choice(id, "Gas");
      if (id === "roof_direction") return choice(id, "South");
      return null; // ev_km: don't know
    });
    const typed = normaliseFacts(a).home;
    // what the voice agent sends for the same answers (docs/voice-agent.md)
    const spoken = normaliseFacts({
      customer_name: "Anna Weber", address: "Musterstraße 1, 80331 München", has_existing_pv: "no", household: "family of four",
      monthly_bill_eur: 120, has_ev: "planned", heating: "gas", roof_direction: "south",
    }).home;
    expect(typed).toEqual(spoken);
    expect(typed).toMatchObject({ annual_kwh: 4100, has_ev: true, ev_km_year: 15000, has_existing_pv: false, heating: "Gas", orientation_deg: 180, demand_is_default: false });
  });

  it("changing an earlier answer drops facts that no longer apply", () => {
    let a: Answers = applyAnswer({}, { has_ev: "yes" });
    a = applyAnswer(a, { ev_km_year: 20000 });
    expect(applyAnswer(a, { has_ev: "no" })).toEqual({ has_ev: "no" });
    expect(applyAnswer({ has_existing_pv: "yes", existing_pv_kwp: 8 }, { has_existing_pv: "no" })).toEqual({ has_existing_pv: "no" });
    expect(applyAnswer({ monthly_bill_eur: 120 }, { annual_kwh: 4500 })).toEqual({ annual_kwh: 4500 });
  });

  it("drafts only once use, bill or household is known (never on the 4,000 kWh default)", () => {
    expect(canDraft({ customer_name: "A", address: "x" })).toBe(false);
    expect(canDraft({ household: 2 })).toBe(true);
    expect(canDraft({ monthly_bill_eur: 90 })).toBe(true);
  });

  it("progress counts follow-ups only when they apply", () => {
    expect(progress([], {})).toEqual({ done: 0, total: 8 });
    expect(progress(["name", "address", "existing_pv"], { has_existing_pv: "yes" })).toEqual({ done: 3, total: 9 });
  });
});

describe("reading 'Other' answers", () => {
  it("numbers in German or English notation", () => {
    expect(readNumber("4,500")).toBe(4500);
    expect(readNumber("4.500 kWh")).toBe(4500);
    expect(readNumber("12,5")).toBe(12.5);
    expect(readNumber("about 8 kWp")).toBe(8);
    expect(readNumber("none")).toBeNull();
    expect(readNumber("0")).toBeNull();
  });

  it("a bill or a yearly use", () => {
    expect(readUsage("€110")).toEqual({ monthly_bill_eur: 110 });
    expect(readUsage("4,500 kWh")).toEqual({ annual_kwh: 4500 });
    expect(readUsage("5200")).toEqual({ annual_kwh: 5200 });
    expect(readUsage("no idea")).toBeNull();
  });

  it("free-text household goes through the voice agent's parser", () => {
    const set = QUESTIONS.find((q) => q.id === "household")!.other!.read("couple with two kids")!;
    expect(normaliseFacts(set).home.inhabitants).toBe(4);
    expect(normaliseFacts(choice("household", "5+")).home.inhabitants).toBe(5);
  });
});
