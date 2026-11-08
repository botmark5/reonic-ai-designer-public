import { FloorPlanError, IMAGE_TYPES, MAX_IMAGE_BYTES, MAX_PDF_BYTES, PDF_TYPE, readFloorPlan } from "@/lib/floorplan-vision";

export const maxDuration = 120; // Claude vision on a detailed plan can take a while

/**
 * POST /api/floorplan (multipart, field "file": PNG, JPG, WEBP or PDF) → { floorPlan } (rooms in metres, see
 * lib/floorplan.ts). Layout for the 3D Inside view only; nothing here changes the energy design.
 */
export async function POST(req: Request) {
  let file: File | null = null;
  try {
    const form = await req.formData();
    const f = form.get("file");
    file = f instanceof File ? f : null;
  } catch {
    return Response.json({ error: "Send the plan as a file upload." }, { status: 400 });
  }
  if (!file) return Response.json({ error: "No file received." }, { status: 400 });

  const type = file.type;
  const isPdf = type === PDF_TYPE;
  if (!isPdf && !(IMAGE_TYPES as readonly string[]).includes(type))
    return Response.json({ error: "Please upload a PNG, JPG or PDF." }, { status: 415 });
  if (file.size > (isPdf ? MAX_PDF_BYTES : MAX_IMAGE_BYTES))
    return Response.json({ error: `The file is too large (max ${isPdf ? 20 : 5} MB).` }, { status: 413 });

  try {
    const floorPlan = await readFloorPlan(Buffer.from(await file.arrayBuffer()), type);
    return Response.json({ floorPlan });
  } catch (e) {
    if (e instanceof FloorPlanError) return Response.json({ error: e.message }, { status: e.status });
    console.error("[floorplan]", e);
    return Response.json({ error: "The plan could not be read right now. Please try again." }, { status: 502 });
  }
}
