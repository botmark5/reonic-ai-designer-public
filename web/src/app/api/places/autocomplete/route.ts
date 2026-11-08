import { autocompleteAddress } from "@/lib/places";
import { allowRequest, clientKey } from "@/lib/solar";

/** GET /api/places/autocomplete?q=…&s=<session> → { available, suggestions: [{ text, main, secondary }] } (Germany). */
export async function GET(req: Request) {
  if (!allowRequest("places", clientKey(req), 120, 60_000)) return Response.json({ available: true, suggestions: [] }, { status: 429 });
  const u = new URL(req.url);
  const r = await autocompleteAddress(u.searchParams.get("q") ?? "", u.searchParams.get("s") ?? undefined);
  return Response.json(r, { headers: { "cache-control": "no-store" } });
}
