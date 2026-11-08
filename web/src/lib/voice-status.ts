/**
 * "Did the voice agent reach us?" Each tool route records its last hits (time, HTTP status, a plain result) in
 * memory; GET on the tool route returns that instance's hits. GET /api/voice/status combines them with the newest
 * call in Supabase (the durable proof) and which secrets are configured. No facts, names or secrets in the output.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export const TOOLS = ["update_facts", "create_design", "post_call"] as const;
export type ToolName = (typeof TOOLS)[number];
export const TOOL_PATH: Record<ToolName, string> = {
  update_facts: "/api/voice/update-facts",
  create_design: "/api/voice/create-design",
  post_call: "/api/voice/post-call",
};

export interface ToolHit {
  at: string;
  status: number;
  result: string;
}

const KEEP = 10;
const hits = new Map<ToolName, ToolHit[]>();

/** What a status code means for the agent's setup, in plain words. */
export function resultFor(tool: ToolName, status: number): string {
  if (status >= 200 && status < 300) return "ok";
  if (status === 401) return tool === "post_call" ? "rejected: webhook signature (ELEVENLABS_WEBHOOK_SECRET)" : "rejected: wrong or missing x-agent-token";
  if (status === 400) return "rejected: bad request (missing conversation_id or no facts)";
  if (status === 429) return "rate limited";
  return `error ${status}`;
}

export function recordHit(tool: ToolName, status: number, now = new Date()): void {
  const list = hits.get(tool) ?? [];
  list.unshift({ at: now.toISOString(), status, result: resultFor(tool, status) });
  hits.set(tool, list.slice(0, KEEP));
}

export function toolHits(tool: ToolName): ToolHit[] {
  return hits.get(tool) ?? [];
}

export function clearToolHits() {
  hits.clear();
}

/** Run a tool handler and record its outcome (an exception counts as 500). */
export async function logged(tool: ToolName, run: () => Promise<Response>): Promise<Response> {
  try {
    const res = await run();
    recordHit(tool, res.status);
    return res;
  } catch (e) {
    recordHit(tool, 500);
    throw e;
  }
}

/** GET on a tool route: this instance's hits. */
export function hitsResponse(tool: ToolName): Response {
  return Response.json({ tool, hits: toolHits(tool) }, { headers: { "cache-control": "no-store" } });
}

export interface CallActivity {
  /** newest calls row: when, status, and which tools left a trace (no facts or names) */
  newest_call: null | {
    created_at: string;
    status: string | null;
    from_update_facts: boolean;
    facts_updated_at: string | null;
    answers: number;
    transcript_turns: number;
  };
  newest_voice_design_at: string | null;
}

export async function callActivity(db: SupabaseClient | null): Promise<CallActivity | { error: string }> {
  if (!db) return { error: "supabase not configured" };
  const [calls, designs] = await Promise.all([
    db.from("calls").select("created_at, status, facts, transcript").order("created_at", { ascending: false }).limit(1),
    db.from("designs").select("created_at").eq("source", "voice").order("created_at", { ascending: false }).limit(1),
  ]);
  if (calls.error) return { error: `calls: ${calls.error.message}` };
  const row = calls.data?.[0] as { created_at: string; status: string | null; facts: Record<string, unknown> | null; transcript: unknown[] | null } | undefined;
  const f = row?.facts ?? {};
  const stated = f.stated && typeof f.stated === "object" ? Object.keys(f.stated as object).length : 0;
  return {
    newest_call: row
      ? {
          created_at: row.created_at,
          status: row.status,
          from_update_facts: typeof f.facts_updated_at === "string",
          facts_updated_at: typeof f.facts_updated_at === "string" ? f.facts_updated_at : null,
          answers: stated,
          transcript_turns: Array.isArray(row.transcript) ? row.transcript.length : 0,
        }
      : null,
    newest_voice_design_at: (designs.data?.[0] as { created_at: string } | undefined)?.created_at ?? null,
  };
}

export interface StatusDeps {
  db: SupabaseClient | null;
  fetch: typeof fetch;
  env: { toolSecret: boolean; webhookSecret: boolean; elevenLabsKey: boolean; ttsEnabled: boolean };
}

/** GET /api/voice/status */
export async function handleVoiceStatus(req: Request, deps: StatusDeps): Promise<Response> {
  const origin = new URL(req.url).origin;
  const perTool = await Promise.all(
    TOOLS.map(async (tool) => {
      try {
        const r = await deps.fetch(new URL(TOOL_PATH[tool], origin), { cache: "no-store", signal: AbortSignal.timeout(3000) });
        const body = r.ok ? ((await r.json()) as { hits?: ToolHit[] }) : null;
        return [tool, body?.hits ?? toolHits(tool)] as const;
      } catch {
        return [tool, toolHits(tool)] as const;
      }
    }),
  );
  const tools = Object.fromEntries(perTool.map(([t, h]) => [t, { last: h[0] ?? null, recent: h }]));
  return Response.json(
    {
      checked_at: new Date().toISOString(),
      config: deps.env,
      tools,
      supabase: await callActivity(deps.db),
      note: "Tool hits are kept in memory per server instance (reset on deploy or cold start); the newest calls row is the durable proof.",
    },
    { headers: { "cache-control": "no-store" } },
  );
}
