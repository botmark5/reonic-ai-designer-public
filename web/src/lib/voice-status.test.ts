import { afterEach, describe, expect, it, vi } from "vitest";
import { clearToolHits, handleVoiceStatus, hitsResponse, logged, recordHit, resultFor, toolHits } from "./voice-status";

afterEach(() => clearToolHits());

describe("voice tool status", () => {
  it("records each hit with a plain-words result, newest first, max 10", async () => {
    await logged("update_facts", async () => new Response(null, { status: 401 }));
    await logged("update_facts", async () => Response.json({ ok: true }));
    const h = toolHits("update_facts");
    expect(h.map((x) => [x.status, x.result])).toEqual([[200, "ok"], [401, "rejected: wrong or missing x-agent-token"]]);
    for (let i = 0; i < 15; i++) recordHit("create_design", 200);
    expect(toolHits("create_design")).toHaveLength(10);
    expect(toolHits("post_call")).toEqual([]);
  });

  it("a thrown handler counts as 500 and still throws", async () => {
    await expect(logged("post_call", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(toolHits("post_call")[0]).toMatchObject({ status: 500, result: "error 500" });
  });

  it("explains the codes per tool", () => {
    expect(resultFor("post_call", 401)).toMatch(/webhook signature/);
    expect(resultFor("create_design", 400)).toMatch(/no facts/);
  });

  it("status combines the tool routes' hits, the newest call (no facts or names) and the config flags", async () => {
    recordHit("update_facts", 200);
    const f = vi.fn(async (u: string | URL | Request) => {
      const path = new URL(String(u)).pathname;
      if (path.endsWith("update-facts")) return hitsResponse("update_facts");
      return new Response("nope", { status: 404 }); // not deployed yet: fall back to this instance's memory
    });
    const row = { created_at: "2026-11-08T10:00:00Z", status: "live", facts: { facts_updated_at: "2026-11-08T10:01:00Z", stated: { customer_name: "Anna", household: 4 }, customer_name: "Anna" }, transcript: [] };
    const q = (data: unknown[]) => ({ select: () => ({ order: () => ({ limit: async () => ({ data, error: null }) }), eq: () => ({ order: () => ({ limit: async () => ({ data: [{ created_at: "2026-11-08T10:02:00Z" }], error: null }) }) }) }) });
    const db = { from: (t: string) => q(t === "calls" ? [row] : []) } as never;
    const res = await handleVoiceStatus(new Request("http://x/api/voice/status"), { db, fetch: f as unknown as typeof fetch, env: { toolSecret: true, webhookSecret: false, elevenLabsKey: false, ttsEnabled: true } });
    const body = await res.json();
    expect(body.tools.update_facts.last).toMatchObject({ status: 200, result: "ok" });
    expect(body.tools.create_design.last).toBeNull();
    expect(body.supabase.newest_call).toEqual({ created_at: row.created_at, status: "live", from_update_facts: true, facts_updated_at: "2026-11-08T10:01:00Z", answers: 2, transcript_turns: 0 });
    expect(body.supabase.newest_voice_design_at).toBe("2026-11-08T10:02:00Z");
    expect(JSON.stringify(body)).not.toContain("Anna");
    expect(body.config).toMatchObject({ toolSecret: true, webhookSecret: false });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
