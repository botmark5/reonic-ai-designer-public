import { connection } from "next/server";
import { engine, DEFAULT_INSTALLER } from "@/lib/engine";
import { errorResponse } from "@/lib/api-route";
import { getStore, type DesignPatch } from "@/lib/store";
import { readJsonCapped } from "@/lib/rate-limit";
import type { Home, Locks } from "@/lib/types";

/** GET /api/designs/:id → the row; runs the engine first if the row has no design yet (e.g. fresh from a call). */
export async function GET(_req: Request, ctx: RouteContext<"/api/designs/[id]">) {
  await connection();
  try {
    const { id } = await ctx.params;
    const store = getStore();
    const row = await store.getDesign(id);
    if (!row) return Response.json({ error: "Design not found." }, { status: 404 });
    if (!row.design || row.design.served?.source === "offline") {
      const design = await engine.design({ installer: DEFAULT_INSTALLER, home: row.home, locks: row.locks });
      return Response.json((await store.updateDesign(id, { design })) ?? { ...row, design });
    }
    return Response.json(row);
  } catch (e) {
    return errorResponse(e);
  }
}

const STATUSES = ["draft", "review", "sent"];

/**
 * PATCH /api/designs/:id { home?, locks?, status?, customer_name?, address? } → saves the planner's state.
 * The design itself is never taken from the client: when home or locks change, the server asks the engine again.
 */
export async function PATCH(req: Request, ctx: RouteContext<"/api/designs/[id]">) {
  try {
    const { id } = await ctx.params;
    const body = (await readJsonCapped<Record<string, unknown>>(req, 64_000)) ?? {};
    const store = getStore();
    const current = await store.getDesign(id);
    if (!current) return Response.json({ error: "Design not found." }, { status: 404 });
    const patch: DesignPatch = {};
    if (typeof body.status === "string" && STATUSES.includes(body.status)) patch.status = body.status as DesignPatch["status"];
    if (typeof body.customer_name === "string") patch.customer_name = body.customer_name.trim().slice(0, 120) || null;
    if (typeof body.address === "string") patch.address = body.address.trim().slice(0, 200) || null;
    if (body.home && typeof body.home === "object") patch.home = { ...current.home, ...(body.home as object) } as Home;
    if (body.locks && typeof body.locks === "object") patch.locks = { ...current.locks, ...(body.locks as object) } as Locks;
    if (patch.home || patch.locks) {
      patch.design = await engine.design({ installer: DEFAULT_INSTALLER, home: patch.home ?? current.home, locks: patch.locks ?? current.locks });
    }
    const row = await store.updateDesign(id, patch);
    return row ? Response.json(row) : Response.json({ error: "Design not found." }, { status: 404 });
  } catch (e) {
    return errorResponse(e);
  }
}
