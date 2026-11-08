import { handleSolarRequest } from "../../../lib/solar";

/** GET /api/solar?address=… → roof summary from Google Solar (or a "not covered" status). Server-only key. */
export async function GET(req: Request) {
  return handleSolarRequest(req);
}
