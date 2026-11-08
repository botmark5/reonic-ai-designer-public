import { engine } from "@/lib/engine";
import { jsonRoute } from "@/lib/api-route";
import type { ValidateRequest } from "@/lib/types";

/** POST /api/engine/validate → engine /validate (or the offline estimate). */
export const POST = jsonRoute((body: ValidateRequest) => engine.validate(body));
