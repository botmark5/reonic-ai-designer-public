import "server-only";
import { EngineError } from "./engine";

/** Wraps a JSON route handler: parses the body, maps errors to JSON responses. */
export function jsonRoute<In, Out>(fn: (body: In) => Promise<Out>) {
  return async (req: Request) => {
    let body: In;
    try {
      body = (await req.json()) as In;
    } catch {
      return Response.json({ error: "Body must be JSON." }, { status: 400 });
    }
    try {
      return Response.json(await fn(body));
    } catch (e) {
      return errorResponse(e);
    }
  };
}

export function errorResponse(e: unknown) {
  if (e instanceof EngineError && e.status >= 400 && e.status < 500)
    return Response.json({ error: e.message }, { status: e.status });
  if (e instanceof EngineError) return Response.json({ error: "The design engine is not reachable right now." }, { status: 503 });
  console.error("[api]", e);
  return Response.json({ error: "Something went wrong on our side." }, { status: 500 });
}
