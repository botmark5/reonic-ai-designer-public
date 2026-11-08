import { after } from "next/server";
import { handleIntake } from "@/lib/intake";
import { voiceDeps } from "@/lib/voice";

/** POST /api/intake { answers } → the voice agent's facts → home → engine draft (planner-only: behind the passcode gate). */
export const maxDuration = 30;

export async function POST(req: Request) {
  return handleIntake(req, voiceDeps(after));
}
