import { engine } from "@/lib/engine";
import { errorResponse } from "@/lib/api-route";
import type { ExplainRequest } from "@/lib/types";

/** POST /api/engine/explain → streamed plain text. Header x-served-by: engine | offline. */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as ExplainRequest;
    const { stream, served } = await engine.explain(body);
    return new Response(stream, {
      headers: { "content-type": "text/plain; charset=utf-8", "x-served-by": served.source, "cache-control": "no-store" },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
