import { DEFAULT_INSTALLER, engine } from "@/lib/engine";
import { lookupSolar } from "@/lib/solar";
import { getStore } from "@/lib/store";
import { handleVisit } from "@/lib/visit";

export const maxDuration = 30; // Google Solar (≤ 8 s) + one engine design

/**
 * POST /api/visit { facts } → 201 { design_id, home, design, location, solar, assumptions, wishes }.
 * The installer's site-visit form (normaliseFacts keys, as the voice agent uses) becomes ONE planner draft with
 * source "form". Behind the planner login (proxy.ts). Every size comes from the engine.
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    const text = await req.text();
    if (text.length > 20_000) return Response.json({ error: "The form is too large." }, { status: 413 });
    body = JSON.parse(text);
  } catch {
    return Response.json({ error: "Body must be JSON." }, { status: 400 });
  }
  const store = getStore();
  const r = await handleVisit(body, {
    installer: process.env.VOICE_INSTALLER || DEFAULT_INSTALLER,
    design: (q) => engine.design(q),
    solar: (a) => lookupSolar(a),
    createDesign: (row) => store.createDesign(row),
  });
  return Response.json(r.body, { status: r.status });
}
