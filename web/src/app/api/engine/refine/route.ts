import { engine } from "@/lib/engine";
import { jsonRoute } from "@/lib/api-route";
import type { RefineRequest } from "@/lib/types";

/** POST /api/engine/refine → engine /refine (text → input changes → new design). */
export const POST = jsonRoute((body: RefineRequest) => engine.refine(body));
