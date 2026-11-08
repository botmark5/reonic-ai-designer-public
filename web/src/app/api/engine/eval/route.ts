import { connection } from "next/server";
import { engine } from "@/lib/engine";
import { errorResponse } from "@/lib/api-route";

/** GET /api/engine/eval → held-out evaluation metrics. */
export async function GET() {
  await connection();
  try {
    return Response.json(await engine.eval());
  } catch (e) {
    return errorResponse(e);
  }
}
