/** The muted "did the voice agent reach us?" line on /live's idle screen, from GET /api/voice/status (d-voice #152). */

export interface VoiceStatus {
  tools?: Partial<Record<"update_facts" | "create_design" | "post_call", { last: { at: string; status: number; result: string } | null }>>;
  supabase?: { newest_call?: { created_at: string; status: string | null; from_update_facts: boolean; answers: number } | null } | { error: string };
}

export interface AgentLine {
  text: string;
  tone: "ok" | "warn" | "none";
}

const hm = (iso: string, now: Date) => {
  const d = new Date(iso);
  const t = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === now.toDateString() ? t : `${d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} ${t}`;
};

/**
 * The newer of: the last tool request that reached this server, or the newest call row in the shared database. On the
 * stage server the agent calls production, so the database row is what tells the presenter the agent is alive.
 */
export function agentLine(s: VoiceStatus | null, now = new Date()): AgentLine {
  if (!s) return { text: "Agent: status unavailable", tone: "none" };
  const hits = Object.entries(s.tools ?? {})
    .map(([tool, v]) => (v?.last ? { tool, ...v.last } : null))
    .filter((x): x is { tool: string; at: string; status: number; result: string } => !!x)
    .sort((a, b) => b.at.localeCompare(a.at));
  const hit = hits[0];
  const call = s.supabase && "newest_call" in s.supabase ? s.supabase.newest_call : null;
  if (call && (!hit || call.created_at > hit.at)) {
    const how = call.from_update_facts ? `${call.answers} ${call.answers === 1 ? "answer" : "answers"} live` : "drafted at hang-up";
    return { text: `Last call ${hm(call.created_at, now)} · ${how}`, tone: "ok" };
  }
  if (hit) return { text: `Agent reached us ${hm(hit.at, now)} · ${hit.tool} ${hit.result}`, tone: hit.result === "ok" ? "ok" : "warn" };
  return { text: "Agent: no contact yet", tone: "none" };
}
