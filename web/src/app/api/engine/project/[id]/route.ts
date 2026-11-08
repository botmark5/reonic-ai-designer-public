import { connection } from "next/server";
import { engine } from "@/lib/engine";
import { errorResponse } from "@/lib/api-route";

/** GET /api/engine/project/:id[?answered=1] → one held-out project: home, expert variants, our design.
 *  `answered=1` asks the engine for the what-if with the planner's existing-solar answer (engine #47). */
export async function GET(req: Request, ctx: RouteContext<"/api/engine/project/[id]">) {
  await connection();
  try {
    const { id } = await ctx.params;
    const answered = new URL(req.url).searchParams.get("answered");
    return Response.json(await engine.project(id, { answered: answered === "1" || answered === "true" }));
  } catch (e) {
    return errorResponse(e);
  }
}
