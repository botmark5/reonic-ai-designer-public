/**
 * Site visit (POST /api/visit): the installer's phone form → the voice pipeline's normalisation → Google Solar roof →
 * the engine → ONE planner draft (source "form"). No new engine API; every size comes from the engine.
 * Dependencies are injected so the handler is testable without Next, Supabase or the network.
 */
import { roofInputsFromSolar } from "./roof";
import type { SolarResult } from "./solar";
import type { DesignRow } from "./supabase";
import { EMPTY_LOCKS, type DesignRequest, type DesignResponse, type Home } from "./types";
import { normaliseFacts } from "./voice";

export const VISIT_SOLAR_BUDGET_MS = 8000;

export interface VisitDeps {
  installer: string;
  design: (req: DesignRequest) => Promise<DesignResponse>;
  solar: (address: string) => Promise<SolarResult>;
  createDesign: (row: Omit<DesignRow, "id" | "created_at">) => Promise<DesignRow>;
  solarBudgetMs?: number;
}

export interface VisitResult {
  design_id: string;
  customer_name: string | null;
  address: string;
  home: Home;
  design: DesignResponse;
  /** null when Google had no roof for the address (the engine then designs without the roof inputs). */
  location: { lat: number; lng: number } | null;
  solar: SolarResult | null;
  assumptions: string[];
  wishes: string | null;
}

export type VisitReply = { status: 201; body: VisitResult } | { status: 400 | 502 | 503; body: { error: string } };

async function within<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<null>((r) => (t = setTimeout(() => r(null), ms)))]);
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Facts use normaliseFacts' keys (the voice agent's), so a visit and a call produce the same Home. */
export async function handleVisit(raw: unknown, deps: VisitDeps): Promise<VisitReply> {
  const facts = raw && typeof raw === "object" ? (raw as { facts?: unknown }).facts ?? raw : raw;
  const { facts: f, home, assumptions } = normaliseFacts(facts);
  const address = f.address?.trim();
  if (!address) return { status: 400, body: { error: "The address is required." } };

  // 1. The house: Google Solar for the address → roof size, the best face's direction and pitch.
  const solar = await within(deps.solar(address), deps.solarBudgetMs ?? VISIT_SOLAR_BUDGET_MS);
  const ok = solar?.status === "ok" ? solar : null;
  const roof = roofInputsFromSolar(ok);
  if (roof) {
    home.roof_max_kwp = roof.roof_max_kwp;
    // A direction the installer chose on site beats Google's face.
    home.roof_azimuth = f.roof_direction && home.orientation_deg != null ? home.orientation_deg : roof.roof_azimuth;
    home.roof_pitch = roof.roof_pitch;
    assumptions.push("Roof size, direction and pitch from Google Solar.");
  } else {
    assumptions.push("No roof data for this address: designed without a roof limit.");
  }

  // 2. The engine designs it (the only source of sizes).
  let design: DesignResponse;
  try {
    design = await deps.design({ installer: deps.installer, home, locks: EMPTY_LOCKS });
  } catch {
    return { status: 503, body: { error: "The design engine is not reachable right now. Please try again." } };
  }

  // 3. One draft in the planner inbox, like a voice draft.
  const base = {
    call_id: null,
    status: "draft" as const,
    customer_name: f.customer_name ?? "Site visit",
    address,
    home,
    locks: EMPTY_LOCKS,
    design,
    explanation: null,
  };
  let row: DesignRow;
  try {
    row = await deps.createDesign({ ...base, source: "form" });
  } catch {
    // Older databases only allow "voice" | "planner" (supabase/migrations/20261108_designs_source_form.sql).
    try {
      row = await deps.createDesign({ ...base, source: "planner" });
    } catch {
      return { status: 502, body: { error: "The draft could not be saved. Please try again." } };
    }
  }

  // Geocoded even when Google has no roof model (status not_covered), so the 3D view can still find the street.
  const location = solar && Number.isFinite(solar.lat) && Number.isFinite(solar.lng) ? { lat: solar.lat as number, lng: solar.lng as number } : null;
  return {
    status: 201,
    body: { design_id: row.id, customer_name: row.customer_name, address, home, design, location, solar: ok, assumptions, wishes: f.wishes },
  };
}
