import { after, connection } from "next/server";
import { handleCreateDesign, voiceDeps } from "../../../../lib/voice";
import { hitsResponse, logged } from "../../../../lib/voice-status";

/** ElevenLabs agent server tool create_design (header x-agent-token). Answers within ~3 s with { instruction }. */
export const maxDuration = 60; // room for after() work (late engine answer + one retry)

export async function POST(req: Request) {
  return logged("create_design", () => handleCreateDesign(req, voiceDeps(after)));
}

/** Last hits on this tool (this server instance): time, HTTP status, result. No request content. */
export async function GET() {
  await connection(); // per request: the hits live in this instance's memory
  return hitsResponse("create_design");
}
