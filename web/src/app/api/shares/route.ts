import { errorResponse } from "@/lib/api-route";
import { defaultAllowed, restrictAllowed } from "@/lib/allowed";
import { getStore } from "@/lib/store";

/**
 * POST /api/shares { design_id, allowed? } → { token, path } for /offer/[token]. Marks the design as sent.
 * allowed = what the installer lets the homeowner change; narrowed here to the engine's own values (restrictAllowed).
 * Without it, everything the engine offers is allowed (as before).
 */
export async function POST(req: Request) {
  try {
    const b = (await req.json()) as { design_id?: string; allowed?: unknown };
    if (!b.design_id) return Response.json({ error: "design_id is required." }, { status: 400 });
    const store = getStore();
    const row = await store.getDesign(b.design_id);
    if (!row?.design) return Response.json({ error: "Design not found." }, { status: 404 });
    const allowed = b.allowed === undefined ? defaultAllowed(row.design) : restrictAllowed(b.allowed, row.design);
    const share = await store.createShare(b.design_id, allowed);
    await store.updateDesign(b.design_id, { status: "sent" });
    return Response.json({ ...share, path: `/offer/${share.token}` }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
