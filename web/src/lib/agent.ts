/**
 * Refine agent (SERVER ONLY): planner text → tool calls → engine design.
 *
 * Claude (claude-sonnet-5-5) reads the planner's request and edits the INPUTS (home facts, locks). Every size comes from
 * run_design, i.e. the engine. Lock values are checked server-side: the model may only lock a size the planner wrote in
 * the request or one the engine itself offered (catalogue alternatives, range ends, the heat pump option).
 *
 * Without ANTHROPIC_API_KEY, or if Claude fails, falls back to engine /refine (keyword / Haiku parser on the engine side).
 */
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { DEFAULT_INSTALLER, engine } from "./engine";
import { diffDesigns, sizeOf } from "./diff";
import { changesLabel, inputChanges, refineSummary } from "./refine-text";
import type { ComponentKey, DesignResponse, Home, Locks } from "./types";

export const AGENT_MODEL = "claude-sonnet-5-5";
const MAX_TURNS = 8;

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool"; name: string; label: string }
  | { type: "design"; response: DesignResponse; home: Home; locks: Locks }
  | { type: "done"; summary: string; home: Home; locks: Locks; response: DesignResponse; by: "claude" | "engine-refine" }
  | { type: "error"; message: string };

export interface AgentInput {
  text: string;
  home: Home;
  locks: Locks;
  installer?: string;
}

const HOME_FIELDS = {
  annual_kwh: "number",
  price_eur_kwh: "number",
  inhabitants: "number",
  has_ev: "boolean",
  ev_km_year: "number",
  heating: "string",
  heating_demand_kwh: "number",
  roof_type: "string",
  has_existing_pv: "boolean",
  existing_pv_kwp: "number",
  existing_battery_kwh: "number",
} as const;
type HomeField = keyof typeof HOME_FIELDS;

const LOCK_KEY: Record<ComponentKey, keyof Locks> = { pv: "pv_kwp", battery: "battery_kwh", wallbox: "wallbox", heatpump: "heatpump_kw" };

const SYSTEM = `You help a solar installer's planner adjust a home energy design (PV, battery, wallbox, heat pump).

The design engine decides every component size from the installer's past offers. You never choose or invent a size.
Your job: turn what the planner says into input changes, run the engine, and report what changed.

How to work:
- Facts about the home (consumption, EV, heating, existing solar, household size, price) go through update_inputs.
- Use lock_component only when the planner asks for a specific component choice ("no battery", "make it 10 kWh",
  "add the heat pump"), or when a wish clearly maps to one of the alternatives the engine offered (for example "as
  independent as possible" → the largest battery alternative run_design listed). Lock values outside what the planner
  said or the engine offered are rejected.
- Always call run_design after changing inputs or locks, then answer.
- If the request is unclear or nothing applies, say so in one sentence instead of guessing.
- A second electric car: the home has one EV field, so add the second car's yearly km to ev_km_year.
- If you changed inputs but no size moved, name the inputs you updated and say the sizes stay the same. Never say
  "nothing changed" after updating an input.

Answer in at most two sentences and 45 words, for a busy planner: what changed and why, with units (kWp, kWh, kW).
Mention a warning only if run_design returned one. Only state sizes that run_design returned. Plain text, no markdown.`;

const TOOLS: Anthropic.Beta.Messages.BetaTool[] = [
  {
    name: "update_inputs",
    description:
      "Change facts about the home. Only include fields the planner's message implies. heating is one of Gas, Oil, Heat pump, Electric, District, Wood. has_existing_pv answers 'Is there already solar on the roof?'. A new EV without a stated distance: use ev_km_year 15000.",
    input_schema: {
      type: "object",
      properties: {
        changes: {
          type: "object",
          properties: Object.fromEntries(
            Object.entries(HOME_FIELDS).map(([k, t]) => [k, { type: [t, "null"] }]),
          ),
          additionalProperties: false,
        },
      },
      required: ["changes"],
      additionalProperties: false,
    },
  },
  {
    name: "lock_component",
    description:
      "Fix one component at a value the planner asked for or the engine offered. value: kWp for pv, kWh for battery, kW for heatpump (0 = none); true/false for wallbox.",
    input_schema: {
      type: "object",
      properties: {
        component: { type: "string", enum: ["pv", "battery", "wallbox", "heatpump"] },
        value: { type: ["number", "boolean"] },
      },
      required: ["component", "value"],
      additionalProperties: false,
    },
  },
  {
    name: "unlock_component",
    description: "Let the engine decide this component again.",
    input_schema: {
      type: "object",
      properties: { component: { type: "string", enum: ["pv", "battery", "wallbox", "heatpump"] } },
      required: ["component"],
      additionalProperties: false,
    },
  },
  {
    name: "run_design",
    description: "Run the design engine with the current inputs and locks. Returns sizes, ranges, alternatives, confidence and checks.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "explain_design",
    description: "Get the engine's reasons and physics for the current design, to explain a choice.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "compare_with_expert",
    description: "What experts sold to the most similar past homes of this installer (consumption, PV, battery).",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
];

export type Unit = "kwh" | "kwp" | "kw" | "km" | "eur" | null;
export interface PlannerNumber {
  value: number;
  unit: Unit;
}

/** Numbers the planner wrote, with the unit right after them ("10 kWh", "12,5 kWp", "15.000 km", "€0.32"). */
export function numbersWithUnits(text: string): PlannerNumber[] {
  return Array.from(text.matchAll(/(€\s*)?(\d+(?:[.,]\d+)*)\s*(kwh|kwp|kw|km|€|eur|euro)?/gi)).map((m) => {
    const s = m[2];
    // "15.000" / "15,000" = thousands; "12,5" / "9.9" = decimals
    const value = /^\d{1,3}([.,]\d{3})+$/.test(s) ? Number(s.replace(/[.,]/g, "")) : Number(s.replace(",", "."));
    const u = (m[3] ?? (m[1] ? "eur" : "")).toLowerCase();
    const unit: Unit = u === "kwh" ? "kwh" : u === "kwp" ? "kwp" : u === "kw" ? "kw" : u === "km" ? "km" : u ? "eur" : null;
    return { value, unit };
  });
}

/** Plain numbers (any unit), kept for callers that do not care about units. */
export function numbersIn(text: string): number[] {
  return numbersWithUnits(text).map((n) => n.value);
}

/** The planner asked to remove or exclude something ("no battery", "without wallbox", "kein Speicher"). */
export function plannerNegates(text: string): boolean {
  return /\b(no|not|without|remove|drop|none|skip|kein\w*|ohne|nicht)\b/i.test(text);
}

const LOCK_UNIT: Record<ComponentKey, Unit> = { pv: "kwp", battery: "kwh", heatpump: "kw", wallbox: null };

/**
 * Values the model may lock a component to (server-side guard: the LLM never picks sizes):
 * sizes the engine offered, sizes the planner wrote WITH the matching unit, and 0 only if the planner said "no/without".
 */
export function allowedLockValues(c: ComponentKey, r: DesignResponse | null, planner: PlannerNumber[] | number[], negates = true): Set<number> {
  const nums: PlannerNumber[] = (planner as (PlannerNumber | number)[]).map((p) => (typeof p === "number" ? { value: p, unit: LOCK_UNIT[c] } : p));
  const s = new Set<number>(nums.filter((p) => p.unit === LOCK_UNIT[c]).map((p) => p.value));
  if (negates) s.add(0);
  if (!r) return s;
  const d = r.design;
  if (c === "pv") {
    if (d.pv.include && d.pv.kwp) s.add(d.pv.kwp);
    if (d.pv.include) d.pv.range?.forEach((x) => s.add(x)); // no new PV (e.g. battery retrofit): the range means nothing
    if (d.pv.include) d.pv.alternatives?.forEach((a) => s.add(a.kwp));
  }
  if (c === "battery") {
    if (d.battery.kwh) s.add(d.battery.kwh);
    d.battery.range?.forEach((x) => s.add(x));
    d.battery.alternatives?.forEach((a) => s.add(a.kwh));
  }
  if (c === "heatpump") {
    const o = r.options?.heatpump;
    if (o?.available) s.add(o.kw);
    if (d.heatpump.option?.kw) s.add(d.heatpump.option.kw);
    if (d.heatpump.kw) s.add(d.heatpump.kw);
  }
  return s;
}

/** Compact design for the model: sizes, ranges, alternatives, checks. */
function summarize(r: DesignResponse) {
  const d = r.design;
  return {
    pv: d.pv.include
      ? { kwp: sizeOf(d, "pv"), typical_range_kwp: d.pv.range, alternatives: d.pv.alternatives, confidence: d.pv.confidence }
      : { kwp: null, note: "no new PV in this design" },
    battery: { kwh: sizeOf(d, "battery"), range_kwh: d.battery.range, alternatives: d.battery.alternatives, confidence: d.battery.confidence },
    wallbox: { included: d.wallbox.include, kw: d.wallbox.kw },
    heatpump: {
      kw: sizeOf(d, "heatpump"),
      option: r.options?.heatpump?.available ? { kw: r.options.heatpump.kw, extra_investment_eur: r.options.heatpump.difference.extra_investment_eur } : null,
    },
    offer_type: r.facts_for_explanation?.offer_type ?? null,
    self_sufficiency: r.physics.autarky,
    own_use: r.physics.self_consumption,
    warnings: r.physics.warnings,
    served_by: r.served?.source ?? "engine",
  };
}

function label(name: string, input: Record<string, unknown>): string {
  if (name === "update_inputs") {
    return changesLabel((input.changes ?? {}) as Record<string, unknown>);
  }
  if (name === "lock_component") return `Lock ${input.component} at ${input.value}`;
  if (name === "unlock_component") return `Unlock ${input.component}`;
  if (name === "run_design") return "Running the design engine";
  if (name === "explain_design") return "Reading the engine's reasons";
  return "Comparing with similar homes";
}

/** Engine /refine as the no-Claude path. */
async function viaEngineRefine(input: AgentInput, emit: (e: AgentEvent) => void) {
  const r = await engine.refine({ text: input.text, home: input.home, locks: input.locks, installer: input.installer ?? DEFAULT_INSTALLER });
  const summary = refineSummary({ text: r.summary, inputs: inputChanges(input.home, r.home), designLines: [] });
  emit({ type: "done", summary, home: r.home, locks: r.locks, response: r.design, by: "engine-refine" });
}

export async function runAgent(input: AgentInput, emit: (e: AgentEvent) => void, signal?: AbortSignal): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) return viaEngineRefine(input, emit);

  const installer = input.installer ?? DEFAULT_INSTALLER;
  let home: Home = { ...input.home };
  let locks: Locks = { ...input.locks };
  // Never trust a design sent by the browser: the starting point is the engine's answer for these inputs.
  let response: DesignResponse = await engine.design({ installer, home, locks });
  const before = response.design;
  const planner = numbersWithUnits(input.text);
  const negates = plannerNegates(input.text);
  let dirty = false; // inputs or locks changed since the last run_design

  const client = new Anthropic();
  const messages: Anthropic.Beta.Messages.BetaMessageParam[] = [
    {
      role: "user",
      content: `Current inputs: ${JSON.stringify(home)}\nCurrent locks: ${JSON.stringify(locks)}\nCurrent design: ${JSON.stringify(
        summarize(response),
      )}\n\nPlanner: ${input.text}`,
    },
  ];

  async function execute(name: string, args: Record<string, unknown>): Promise<{ content: string; is_error?: boolean }> {
    if (name === "update_inputs") {
      const changes = (args.changes ?? {}) as Record<string, unknown>;
      const applied: Partial<Home> = {};
      for (const [k, v] of Object.entries(changes)) {
        const t = HOME_FIELDS[k as HomeField];
        if (!t) return { content: `Unknown field ${k}.`, is_error: true };
        if (v !== null && typeof v !== t) return { content: `${k} must be a ${t}.`, is_error: true };
        if (typeof v === "number" && (v < 0 || !Number.isFinite(v))) return { content: `${k} must be ≥ 0.`, is_error: true };
        // Numbers must come from the planner's words (the model never invents consumption, distances or sizes).
        // A second car adds its stated distance to the current one (current km + a number the planner wrote).
        const addsCar = k === "ev_km_year" && typeof v === "number" && planner.some((p) => Math.abs((home.ev_km_year ?? 0) + p.value - v) < 0.051);
        if (typeof v === "number" && !planner.some((p) => Math.abs(p.value - v) < 0.051) && !(k === "ev_km_year" && v === 15000) && !addsCar && !(v === 0 && negates))
          return { content: `Rejected: ${k} = ${v} is not a number the planner wrote. Only change numbers the planner gave.`, is_error: true };
        (applied as Record<string, unknown>)[k] = v;
      }
      if (applied.has_ev === true && home.ev_km_year == null && applied.ev_km_year == null) applied.ev_km_year = 15000;
      if (typeof applied.annual_kwh === "number") applied.demand_is_default = false; // the planner gave a real figure
      home = { ...home, ...applied };
      dirty = true;
      return { content: `Updated: ${JSON.stringify(applied)}. Call run_design to see the effect.` };
    }
    if (name === "lock_component" || name === "unlock_component") {
      const c = args.component as ComponentKey;
      if (!(c in LOCK_KEY)) return { content: "Unknown component.", is_error: true };
      if (name === "unlock_component") {
        locks = { ...locks, [LOCK_KEY[c]]: null };
        dirty = true;
        return { content: `${c} unlocked.` };
      }
      const v = args.value;
      if (c === "wallbox") {
        if (typeof v !== "boolean") return { content: "wallbox takes true or false.", is_error: true };
        if (v === false && !negates) return { content: "Rejected: remove the wallbox only when the planner says so.", is_error: true };
        locks = { ...locks, wallbox: v };
        dirty = true;
        return { content: `wallbox locked: ${v}.` };
      }
      if (typeof v !== "number") return { content: `${c} takes a number.`, is_error: true };
      const allowed = allowedLockValues(c, response, planner, negates);
      const ok = [...allowed].some((a) => Math.abs(a - v) < 0.051);
      if (!ok)
        return {
          content: `Rejected: ${v} is neither a value the planner wrote nor one the engine offered for ${c} (allowed: ${[...allowed].sort((a, b) => a - b).join(", ")}). Sizes come from the engine.`,
          is_error: true,
        };
      locks = { ...locks, [LOCK_KEY[c]]: v };
      dirty = true;
      return { content: `${c} locked at ${v}.` };
    }
    if (name === "run_design") {
      response = await engine.design({ installer, home, locks });
      dirty = false;
      emit({ type: "design", response, home, locks });
      return { content: JSON.stringify(summarize(response)) };
    }
    if (name === "explain_design") {
      const d = response.design;
      return {
        content: JSON.stringify({
          reasons: { pv: d.pv.reasons, battery: d.battery.reasons, wallbox: d.wallbox.reasons, heatpump: d.heatpump.reasons },
          physics: response.physics,
          economics: response.economics ?? null,
        }),
      };
    }
    if (name === "compare_with_expert") {
      return { content: JSON.stringify(response.similar_homes) };
    }
    return { content: `Unknown tool ${name}.`, is_error: true };
  }

  let finalText = "";
  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const stream = client.beta.messages.stream(
        {
          model: AGENT_MODEL,
          max_tokens: 4000,
          system: SYSTEM,
          tools: TOOLS,
          messages,
          output_config: { effort: "low" },
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        },
        { signal },
      );
      let turnText = "";
      stream.on("text", (delta) => {
        turnText += delta;
        emit({ type: "text", text: delta });
      });
      const message = await stream.finalMessage();
      if (turnText.trim()) finalText = turnText; // the summary is the last thing Claude said

      if (message.stop_reason === "refusal") throw new Error("Claude declined this request.");
      if (message.stop_reason === "pause_turn") {
        messages.push({ role: "assistant", content: message.content });
        continue;
      }
      const uses = message.content.filter((b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === "tool_use");
      if (uses.length === 0 || message.stop_reason === "end_turn") break;
      if (message.stop_reason === "max_tokens") throw new Error("The reply was cut off.");

      messages.push({ role: "assistant", content: message.content });
      const results: Anthropic.Beta.Messages.BetaToolResultBlockParam[] = [];
      for (const u of uses) {
        const args = (u.input ?? {}) as Record<string, unknown>;
        emit({ type: "tool", name: u.name, label: label(u.name, args) });
        const r = await execute(u.name, args);
        results.push({ type: "tool_result", tool_use_id: u.id, content: r.content, is_error: r.is_error });
      }
      messages.push({ role: "user", content: results });
    }
  } catch (e) {
    if (signal?.aborted) return;
    console.warn("[agent] Claude failed, using engine /refine:", (e as Error).message);
    return viaEngineRefine(input, emit);
  }

  // Inputs changed after the last run (or the model never ran the engine): the returned design must match them.
  if (dirty) response = await engine.design({ installer, home, locks });
  const diff = diffDesigns(before, response.design);
  const summary = refineSummary({ text: finalText, inputs: inputChanges(input.home, home), designLines: diff.lines });
  emit({ type: "done", summary, home, locks, response, by: "claude" });
}
