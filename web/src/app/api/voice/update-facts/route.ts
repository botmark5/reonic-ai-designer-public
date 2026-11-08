import { after, connection } from "next/server";
import { handleUpdateFacts, voiceDeps } from "../../../../lib/voice";
import { hitsResponse, logged } from "../../../../lib/voice-status";

export const maxDuration = 30; // after(): Google roof lookup for a new address

export async function POST(req: Request) {
  return logged("update_facts", () => handleUpdateFacts(req, voiceDeps(after)));
}

/** Last hits on this tool (this server instance): time, HTTP status, result. No request content. */
export async function GET() {
  await connection(); // per request: the hits live in this instance's memory
  return hitsResponse("update_facts");
}
