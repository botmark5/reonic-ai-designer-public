import { connection } from "next/server";
import { errorResponse } from "@/lib/api-route";
import { getStore } from "@/lib/store";

/**
 * GET /api/calls → the latest calls with their draft design, newest first.
 * Served by the server (service role) so the browser never needs anon read on calls (names, addresses, transcripts).
 */
export async function GET() {
  await connection();
  try {
    const store = getStore();
    const calls = await store.listCalls(8);
    const latest = calls[0] ? await store.designForCall(calls[0].id) : null;
    return Response.json({ calls, latestDesign: latest }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
