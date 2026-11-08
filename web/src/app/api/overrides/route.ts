import { errorResponse } from "@/lib/api-route";
import { getStore } from "@/lib/store";
import type { OverrideRow } from "@/lib/supabase";

/** POST /api/overrides { design_id, component, from_value, to_value, reason?, by? }: every manual change is logged. */
export async function POST(req: Request) {
  try {
    const b = (await req.json()) as Partial<OverrideRow>;
    if (!b.design_id || !b.component) return Response.json({ error: "design_id and component are required." }, { status: 400 });
    const row = await getStore().addOverride({
      design_id: b.design_id, component: b.component, from_value: b.from_value ?? null, to_value: b.to_value ?? null,
      reason: b.reason ?? null, by: b.by ?? "planner",
    });
    return Response.json(row, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
