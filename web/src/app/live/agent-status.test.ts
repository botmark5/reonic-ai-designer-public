import { describe, expect, it } from "vitest";
import { agentLine } from "./agent-status";

const now = new Date("2026-11-08T12:00:00");
const iso = (hm: string, day = "2026-11-08") => new Date(`${day}T${hm}:00`).toISOString();

describe("agentLine", () => {
  it("no contact yet", () => {
    expect(agentLine({ tools: { update_facts: { last: null } }, supabase: { newest_call: null } }, now)).toEqual({ text: "Agent: no contact yet", tone: "none" });
  });
  it("the newest tool hit, with its plain result", () => {
    const l = agentLine({ tools: { update_facts: { last: { at: iso("10:41"), status: 200, result: "ok" } }, create_design: { last: { at: iso("10:30"), status: 200, result: "ok" } } } }, now);
    expect(l).toEqual({ text: "Agent reached us 10:41 · update_facts ok", tone: "ok" });
  });
  it("a rejected tool is a warning", () => {
    const l = agentLine({ tools: { create_design: { last: { at: iso("10:41"), status: 401, result: "rejected: wrong or missing x-agent-token" } } } }, now);
    expect(l.tone).toBe("warn");
    expect(l.text).toMatch(/create_design rejected: wrong or missing x-agent-token/);
  });
  it("on stage the shared call row wins when newer", () => {
    const l = agentLine({ tools: { update_facts: { last: null } }, supabase: { newest_call: { created_at: iso("10:47"), status: "ended", from_update_facts: true, answers: 3 } } }, now);
    expect(l).toEqual({ text: "Last call 10:47 · 3 answers live", tone: "ok" });
    const old = agentLine({ supabase: { newest_call: { created_at: iso("09:00", "2026-11-07"), status: null, from_update_facts: false, answers: 0 } } }, now);
    expect(old.text).toMatch(/^Last call 7 Nov 09:00 · drafted at hang-up$/);
  });
  it("no status → unavailable", () => {
    expect(agentLine(null).tone).toBe("none");
  });
});
