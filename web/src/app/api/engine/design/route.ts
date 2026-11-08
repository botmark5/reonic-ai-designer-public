import { engine } from "@/lib/engine";
import { jsonRoute } from "@/lib/api-route";
import type { DesignRequest } from "@/lib/types";

/** POST /api/engine/design → engine /design (or the offline estimate). */
export const POST = jsonRoute((body: DesignRequest) => engine.design(body));
