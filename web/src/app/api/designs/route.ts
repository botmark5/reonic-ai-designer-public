import { connection } from "next/server";
import { engine, DEFAULT_INSTALLER } from "@/lib/engine";
import { errorResponse } from "@/lib/api-route";
import { getStore, NEW_HOME, NEW_LOCKS } from "@/lib/store";
import type { DesignRow } from "@/lib/supabase";
import type { Home, Locks } from "@/lib/types";

/** GET /api/designs → newest first. */
export async function GET() {
  await connection();
  try {
    return Response.json(await getStore().listDesigns());
  } catch (e) {
    return errorResponse(e);
  }
}

/** POST /api/designs { customer_name, address?, home?, locks?, source?, call_id? } → runs the engine, stores, returns the row. */
export async function POST(req: Request) {
  try {
    const b = (await req.json()) as Partial<DesignRow> & { home?: Partial<Home>; locks?: Partial<Locks> };
    const home = { ...NEW_HOME, ...(b.home ?? {}) } as Home;
    const locks = { ...NEW_LOCKS, ...(b.locks ?? {}) } as Locks;
    const design = await engine.design({ installer: DEFAULT_INSTALLER, home, locks });
    const row = await getStore().createDesign({
      call_id: b.call_id ?? null, source: b.source ?? "planner", status: "draft",
      customer_name: b.customer_name?.trim() || "New home", address: b.address ?? null,
      home, locks, design, explanation: null,
    });
    return Response.json(row, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
