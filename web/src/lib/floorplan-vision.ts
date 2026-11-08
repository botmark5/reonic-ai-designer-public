/**
 * Floor plan drawing → rooms in metres, with Claude vision and a strict JSON schema (SERVER ONLY).
 * Layout only: the result feeds the 3D Inside view. No energy-system size ever comes from it.
 */
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { ROOM_KINDS, sanitizeFloorPlan, type FloorPlan } from "./floorplan";

export const FLOORPLAN_MODEL = "claude-sonnet-5-5";

export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export const PDF_TYPE = "application/pdf";
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // Claude's per-image limit
export const MAX_PDF_BYTES = 20 * 1024 * 1024;

const SCHEMA = {
  type: "object",
  properties: {
    is_floor_plan: { type: "boolean" },
    widthM: { type: "number" },
    depthM: { type: "number" },
    rooms: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          kind: { type: "string", enum: [...ROOM_KINDS] },
          x: { type: "number" },
          y: { type: "number" },
          w: { type: "number" },
          h: { type: "number" },
          floor: { type: "integer", enum: [-1, 0, 1] },
        },
        required: ["name", "kind", "x", "y", "w", "h", "floor"],
        additionalProperties: false,
      },
    },
  },
  required: ["is_floor_plan", "widthM", "depthM", "rooms"],
  additionalProperties: false,
} as const;

const PROMPT = `This is an architectural floor plan of a home. Read its room layout so a 3D view can draw the rooms.

Return the outer footprint (widthM = left to right, depthM = top to bottom of the drawing) and every room as an
axis-aligned rectangle in metres. The origin (0, 0) is the top-left corner of the outer footprint as drawn; x runs
right, y runs down the drawing. Approximate L-shaped or angled rooms by their main rectangle.

Scale: use the dimension labels or the scale bar. If there are none, assume an interior door is 0.9 m wide.
name = the label as written on the plan (keep the plan's language). kind = the closest of the allowed kinds; a
boiler, heating, technical or laundry room is "utility". floor: -1 basement, 0 ground floor, 1 upper floor. If the
sheet shows several floors side by side, give each floor's rooms in that floor's own coordinates (each starting at its
own top-left corner) and the largest floor's footprint.

If the image is not a floor plan, set is_floor_plan to false and return no rooms.`;

export class FloorPlanError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Sends the drawing to Claude; returns the sanitized plan or throws FloorPlanError with a planner-readable message. */
export async function readFloorPlan(bytes: Buffer, mediaType: string): Promise<FloorPlan> {
  if (!process.env.ANTHROPIC_API_KEY) throw new FloorPlanError(503, "Floor plan reading is not set up on this server.");
  const data = bytes.toString("base64");
  const source: Anthropic.ContentBlockParam =
    mediaType === PDF_TYPE
      ? { type: "document", source: { type: "base64", media_type: PDF_TYPE, data } }
      : { type: "image", source: { type: "base64", media_type: mediaType as (typeof IMAGE_TYPES)[number], data } };

  const client = new Anthropic({ timeout: 90_000, maxRetries: 1 });
  const res = await client.messages.create({
    model: FLOORPLAN_MODEL,
    max_tokens: 8000,
    output_config: { format: { type: "json_schema", schema: SCHEMA } },
    messages: [{ role: "user", content: [source, { type: "text", text: PROMPT }] }],
  });
  if (res.stop_reason === "refusal") throw new FloorPlanError(422, "This file could not be read as a floor plan.");
  if (res.stop_reason === "max_tokens") throw new FloorPlanError(422, "The plan has too many rooms to read in one go.");
  const text = res.content.find((b) => b.type === "text")?.text;
  let raw: unknown;
  try {
    raw = text ? JSON.parse(text) : null;
  } catch {
    raw = null;
  }
  if (raw && typeof raw === "object" && (raw as { is_floor_plan?: unknown }).is_floor_plan === false)
    throw new FloorPlanError(422, "This doesn't look like a floor plan.");
  const plan = sanitizeFloorPlan(raw);
  if (!plan) throw new FloorPlanError(422, "No rooms could be read from this plan.");
  return plan;
}
