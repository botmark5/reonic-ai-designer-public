/**
 * /intake: the typed twin of the voice agent. The same questions, in the same order as the agent's prompt
 * (docs/voice-agent.md), each with option chips, an "Other" field and "Skip / don't know".
 * Answers use the voice agent's field names (update_facts / create_design), so the server maps them with the same
 * normaliseFacts and the engine gets the same home for the same answers. Nothing here picks a size.
 */

/** The answers so far, keyed like the voice agent's tool parameters (raw values; the server normalises them). */
export type Answers = Record<string, string | number | boolean>;

export interface Choice {
  label: string;
  /** Facts this choice sets (voice-agent field names). */
  set: Answers;
}

export interface Question {
  id: string;
  /** What the assistant asks. */
  ask: (a: Answers) => string;
  choices: Choice[];
  /** Free input ("Other"): returns the facts it sets, or null when it can't be read. */
  other?: { label: string; placeholder: string; inputMode: "text" | "numeric" | "decimal"; read: (s: string) => Answers | null };
  /** Shown only when this holds (follow-up questions). */
  when?: (a: Answers) => boolean;
  /** Label of the skip chip; skipping sets nothing (the server states its assumption). */
  skip: string;
}

/** "4,500", "4.500 kWh", "12,5" → a number (German or English separators), else null. */
export function readNumber(s: string): number | null {
  const m = s.trim().match(/\d[\d.,]*/);
  if (!m) return null;
  let t = m[0].replace(/[.,]$/, "");
  t = /^\d{1,3}([.,]\d{3})+$/.test(t) ? t.replace(/[.,]/g, "") : t.replace(",", ".");
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** "€120", "120 a month" → monthly bill; "4,500 kWh" or any figure above 1,000 → yearly use. */
export function readUsage(s: string): Answers | null {
  const n = readNumber(s);
  if (n == null) return null;
  if (/kwh/i.test(s) || n > 1000) return { annual_kwh: n };
  return { monthly_bill_eur: n };
}

const text = (field: string) => (s: string) => (s.trim() ? { [field]: s.trim() } : null);
const num = (field: string) => (s: string) => {
  const n = readNumber(s);
  return n == null ? null : { [field]: n };
};
const firstName = (a: Answers) => (typeof a.customer_name === "string" ? a.customer_name.trim().split(/\s+/)[0] : "");

export const EXAMPLE_ADDRESS = "Musterstraße 1, 80331 München";

export const QUESTIONS: Question[] = [
  {
    id: "name",
    ask: () => "Hi, I'm the Reonic design assistant. I'll ask the same few questions as a site visit, and the house on the right builds as you answer. Who am I talking to?",
    choices: [],
    other: { label: "Name", placeholder: "Your name", inputMode: "text", read: text("customer_name") },
    skip: "Skip",
  },
  {
    id: "address",
    ask: (a) => `${firstName(a) ? `Thanks, ${firstName(a)}. ` : ""}Which address is the house at? I'll look the roof up.`,
    choices: [{ label: EXAMPLE_ADDRESS, set: { address: EXAMPLE_ADDRESS } }],
    other: { label: "Address", placeholder: "Street, number, postcode, town", inputMode: "text", read: text("address") },
    skip: "Skip",
  },
  {
    id: "existing_pv",
    ask: () => "Is there already solar on your roof?",
    choices: [
      { label: "No", set: { has_existing_pv: "no" } },
      { label: "Yes", set: { has_existing_pv: "yes" } },
    ],
    other: { label: "Yes, size", placeholder: "e.g. 8 kWp", inputMode: "decimal", read: (s) => { const n = readNumber(s); return n == null ? null : { has_existing_pv: "yes", existing_pv_kwp: n }; } },
    skip: "Not sure",
  },
  {
    id: "existing_pv_kwp",
    ask: () => "Roughly how big is it?",
    when: (a) => a.has_existing_pv === "yes" && a.existing_pv_kwp == null,
    choices: [5, 8, 10, 15].map((n) => ({ label: `${n} kWp`, set: { existing_pv_kwp: n } })),
    other: { label: "Size", placeholder: "kWp", inputMode: "decimal", read: num("existing_pv_kwp") },
    skip: "Don't know",
  },
  {
    id: "household",
    ask: () => "How many people live in the house?",
    choices: [...[1, 2, 3, 4].map((n): Choice => ({ label: String(n), set: { household: n } })), { label: "5+", set: { household: "5+" } }],
    other: { label: "Other", placeholder: "e.g. 6, or \"couple with two kids\"", inputMode: "text", read: text("household") },
    skip: "Skip",
  },
  {
    id: "usage",
    ask: () => "About how much is your electricity bill a month? Your yearly use in kWh works too.",
    choices: [60, 90, 120, 150, 200].map((n) => ({ label: `€${n} / month`, set: { monthly_bill_eur: n } })),
    other: { label: "Bill or kWh", placeholder: "e.g. €110, or 4,500 kWh", inputMode: "text", read: readUsage },
    skip: "Don't know",
  },
  {
    id: "ev",
    ask: () => "Do you drive an electric car, or are you planning to get one?",
    choices: [
      { label: "No", set: { has_ev: "no" } },
      { label: "Yes", set: { has_ev: "yes" } },
      { label: "Planned (next year)", set: { has_ev: "planned" } },
    ],
    skip: "Not sure",
  },
  {
    id: "ev_km",
    ask: () => "About how many kilometres a year will it drive?",
    when: (a) => a.has_ev === "yes" || a.has_ev === "planned",
    choices: [10000, 15000, 20000].map((n) => ({ label: `${n.toLocaleString("en-US")} km`, set: { ev_km_year: n } })),
    other: { label: "Other", placeholder: "km per year", inputMode: "numeric", read: num("ev_km_year") },
    skip: "Don't know",
  },
  {
    id: "heating",
    ask: () => "How is the house heated today?",
    choices: [
      { label: "Gas", set: { heating: "gas" } },
      { label: "Oil", set: { heating: "oil" } },
      { label: "Heat pump", set: { heating: "heatpump" } },
      { label: "Electric", set: { heating: "electric" } },
      { label: "District heating", set: { heating: "district" } },
      { label: "Wood", set: { heating: "wood" } },
    ],
    other: { label: "Other", placeholder: "e.g. pellets", inputMode: "text", read: () => ({ heating: "other" }) },
    skip: "Don't know",
  },
  {
    id: "roof_direction",
    ask: (a) =>
      a.address
        ? "Last one: which way does the roof face? Skip it if you're unsure; I'll use the roof Google shows for your address."
        : "Last one: which way does the roof face?",
    choices: [
      { label: "South", set: { roof_direction: "south" } },
      { label: "South-east", set: { roof_direction: "south_east" } },
      { label: "South-west", set: { roof_direction: "south_west" } },
      { label: "East-west", set: { roof_direction: "east_west" } },
      { label: "East", set: { roof_direction: "east" } },
      { label: "West", set: { roof_direction: "west" } },
      { label: "North", set: { roof_direction: "north" } },
    ],
    skip: "Don't know",
  },
];

/** The next question to ask after `answered` (ids already answered or skipped), or null when done. */
export function nextQuestion(answered: readonly string[], a: Answers): Question | null {
  return QUESTIONS.find((q) => !answered.includes(q.id) && (!q.when || q.when(a))) ?? null;
}

/** Questions still to come (for the progress bar): the ones not answered whose condition holds now. */
export function progress(answered: readonly string[], a: Answers): { done: number; total: number } {
  const relevant = QUESTIONS.filter((q) => !q.when || q.when(a) || answered.includes(q.id));
  return { done: relevant.filter((q) => answered.includes(q.id)).length, total: relevant.length };
}

/**
 * Apply an answer. Changing an earlier answer drops facts that no longer apply (an EV "no" removes the km;
 * existing solar "no" removes its size), so follow-up questions never leave stale facts behind.
 */
export function applyAnswer(a: Answers, set: Answers): Answers {
  const next = { ...a, ...set };
  if (set.has_ev === "no") delete next.ev_km_year;
  if (set.has_existing_pv === "no") delete next.existing_pv_kwp;
  if ("annual_kwh" in set) delete next.monthly_bill_eur;
  if ("monthly_bill_eur" in set) delete next.annual_kwh;
  return next;
}

/** Enough to draft without inventing the household's use (same rule as the voice agent's create_design). */
export function canDraft(a: Answers): boolean {
  return a.annual_kwh != null || a.monthly_bill_eur != null || a.household != null;
}
