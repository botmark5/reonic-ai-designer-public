import { DEFAULT_INSTALLER, engine } from "@/lib/engine";
import { errorResponse } from "@/lib/api-route";
import { choiceAllowed, getOfferWithId } from "@/lib/offer";
import { allowRequest, clientKey, readJsonCapped } from "@/lib/rate-limit";
import { handleExplain, voiceDeps } from "@/lib/voice";
import { after } from "next/server";
import { getStore } from "@/lib/store";

/**
 * POST /api/offer/:token (public: the token is the homeowner's access; rate-limited)
 *   { action: "variant", battery_kwh?, wallbox? } → the engine's design for that choice (only allowed values)
 *   { action: "accept", battery_kwh?, wallbox? }  → logs the homeowner's choice (overrides row, by "homeowner")
 *   { action: "listen" }                            → session D's offer explanation (text + audio when enabled)
 *   { action: "explain" }                           → the engine's homeowner explanation, streamed text (fallback)
 */
export async function POST(req: Request, ctx: RouteContext<"/api/offer/[token]">) {
  try {
    if (!allowRequest("offer", clientKey(req), 40, 60_000)) return Response.json({ error: "Too many requests. Wait a minute." }, { status: 429 });
    const { token } = await ctx.params;
    const body = (await readJsonCapped<{ action?: string; pv_kwp?: number; battery_kwh?: number; wallbox?: boolean; heatpump?: boolean }>(req, 4_000)) ?? {};
    const offer = await getOfferWithId(token);
    if (!offer) return Response.json({ error: "This offer link is not valid." }, { status: 404 });
    if (body.action === "listen") {
      const payload = offer.designId ? { design_id: offer.designId, audio: true } : { design_response: offer.design, audio: true };
      return handleExplain(
        new Request(new URL("/api/voice/explain", req.url), { method: "POST", headers: req.headers, body: JSON.stringify(payload) }),
        { ...voiceDeps(after), allowInlineDesign: true }, // the design comes from our server, not the client
      );
    }
    if (body.action === "explain") {
      const { stream } = await engine.explain({ design_response: offer.design, audience: "homeowner" });
      return new Response(stream, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
    }
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    const bool = (v: unknown) => (typeof v === "boolean" ? v : undefined);
    const choice = { pv_kwp: num(body.pv_kwp), battery_kwh: num(body.battery_kwh), wallbox: bool(body.wallbox), heatpump: bool(body.heatpump) };
    if (!choiceAllowed(offer.allowed, choice)) return Response.json({ error: "Your installer did not offer this option." }, { status: 400 });

    if (body.action === "accept") {
      if (offer.designId)
        await getStore().addOverride({
          design_id: offer.designId, component: "homeowner.accept", from_value: null, to_value: choice,
          reason: "Homeowner accepted the offer", by: "homeowner",
        });
      return Response.json({ ok: true });
    }
    const locks = {
      ...offer.locks,
      ...(choice.pv_kwp !== undefined ? { pv_kwp: choice.pv_kwp } : {}),
      ...(choice.battery_kwh !== undefined ? { battery_kwh: choice.battery_kwh } : {}),
      ...(choice.wallbox !== undefined ? { wallbox: choice.wallbox } : {}),
    };
    return Response.json(await engine.design({ installer: DEFAULT_INSTALLER, home: offer.home, locks }));
  } catch (e) {
    return errorResponse(e);
  }
}
