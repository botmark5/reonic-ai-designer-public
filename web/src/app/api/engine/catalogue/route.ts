import { connection } from "next/server";
import { engine } from "@/lib/engine";

/** One engine call per server instance; a failure is retried on the next request. */
let cached: Promise<Record<string, { battery_kwh?: number[] }> | null> | null = null;
const catalogue = () =>
  (cached ??= engine.installers().catch(() => {
    cached = null;
    return null;
  }));

/** GET /api/engine/catalogue?installer=… → { battery_kwh: number[] }: the battery sizes this installer sells.
 *  Empty list when the engine is unreachable (the editor then offers only the engine's own sizes). */
export async function GET(req: Request) {
  await connection();
  const installer = new URL(req.url).searchParams.get("installer") ?? "";
  const sizes = (await catalogue())?.[installer]?.battery_kwh;
  return Response.json({ battery_kwh: Array.isArray(sizes) ? sizes.filter((s) => typeof s === "number") : [] });
}
