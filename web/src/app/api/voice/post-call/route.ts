import { after, connection } from "next/server";
import { handlePostCall, voiceDeps } from "../../../../lib/voice";
import { hitsResponse, logged } from "../../../../lib/voice-status";

/** ElevenLabs post-call webhook (HMAC on the raw body): stores transcript, summary and collected facts. */
export const maxDuration = 60; // room for after() work (late engine answer + one retry)

export async function POST(req: Request) {
  return logged("post_call", () => handlePostCall(req, voiceDeps(after)));
}

/** Last hits on this tool (this server instance): time, HTTP status, result. No request content. */
export async function GET() {
  await connection(); // per request: the hits live in this instance's memory
  return hitsResponse("post_call");
}
