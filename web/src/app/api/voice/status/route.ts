import { connection } from "next/server";
import { handleVoiceStatus } from "../../../../lib/voice-status";
import { getServerSupabase } from "../../../../lib/supabase";

/** GET /api/voice/status: when each agent tool last reached this deployment, the result, and the newest call row. */
export async function GET(req: Request) {
  await connection(); // per request, never prerendered
  const env = process.env;
  return handleVoiceStatus(req, {
    db: getServerSupabase(),
    fetch: (...a) => fetch(...a),
    env: {
      toolSecret: !!env.ELEVENLABS_TOOL_SECRET,
      webhookSecret: !!env.ELEVENLABS_WEBHOOK_SECRET,
      elevenLabsKey: !!env.ELEVENLABS_API_KEY,
      ttsEnabled: env.VOICE_TTS_ENABLED === "true",
    },
  });
}
