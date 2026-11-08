import { handleLayersRequest } from "../../../../lib/solar-layers";

export const maxDuration = 30; // three Google downloads + GeoTIFF decode on a cold cache

export async function GET(req: Request) {
  return handleLayersRequest(req);
}
