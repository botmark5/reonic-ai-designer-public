import { handlePanelsRequest } from "../../../../lib/solar-panels";

export async function GET(req: Request) {
  return handlePanelsRequest(req);
}
