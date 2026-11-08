import { runAgent, type AgentEvent, type AgentInput } from "@/lib/agent";
import { allowRequest, clientKey, readJsonCapped } from "@/lib/rate-limit";

/**
 * POST /api/agent { text, home, locks } → NDJSON stream of AgentEvent:
 * text deltas, tool steps, intermediate designs, then { type: "done", summary, home, locks, response }.
 * Planner-only (proxy.ts), rate-limited, body capped; the design is rebuilt on the server.
 */
export async function POST(req: Request) {
  if (!allowRequest("agent", clientKey(req), 15, 60_000)) return Response.json({ error: "Too many requests. Wait a minute." }, { status: 429 });
  const input = await readJsonCapped<AgentInput>(req, 16_000);
  if (!input?.text?.trim() || !input.home || typeof input.home !== "object") return Response.json({ error: "text and home are required." }, { status: 400 });

  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (e: AgentEvent) => controller.enqueue(enc.encode(JSON.stringify(e) + "\n"));
      try {
        await runAgent({ text: input.text.slice(0, 2000), home: input.home, locks: input.locks ?? { pv_kwp: null, battery_kwh: null, wallbox: null, heatpump_kw: null }, installer: input.installer }, emit, req.signal);
      } catch (e) {
        emit({ type: "error", message: (e as Error).message || "The designer could not update the design." });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
}
