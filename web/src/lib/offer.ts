/**
 * Homeowner offer: which choices a share allows, and resolving a share token to a design. SERVER ONLY.
 */
import "server-only";
import { DEFAULT_INSTALLER, engine } from "./engine";
import { getStore } from "./store";
import type { DesignRow } from "./supabase";
import type { DesignResponse, Home, Locks } from "./types";
import { EMPTY_LOCKS } from "./types";
import { defaultAllowed, restrictAllowed, type AllowedVariant } from "./allowed";

export { choiceAllowed, defaultAllowed, type AllowedVariant } from "./allowed";

/** What the homeowner's browser receives (no design id: the token is the only handle). */
export interface Offer {
  token: string;
  customer: string | null;
  home: Home;
  locks: Locks;
  design: DesignResponse;
  allowed: AllowedVariant[];
}

export const DEMO_HOME: Home = {
  annual_kwh: 4800, price_eur_kwh: 0.32, load_profile: "H0", has_ev: true, ev_km_year: 15000, existing_pv_kwp: null,
  existing_battery_kwh: null, heating: "Gas", heating_demand_kwh: null, roof_type: "Concrete tile", house_sqm: null,
  inhabitants: 4, has_existing_pv: false, demand_is_default: false,
};

export async function getOfferWithId(token: string): Promise<(Offer & { designId: string | null }) | null> {
  if (token === "demo") {
    const o = await getOffer(token);
    return o && { ...o, designId: null };
  }
  const found = await getStore().getShare(token);
  if (!found) return null;
  const o = await getOffer(token);
  return o && { ...o, designId: found.design.id };
}

export async function getOffer(token: string): Promise<Offer | null> {
  if (token === "demo") {
    const design = await engine.design({ installer: DEFAULT_INSTALLER, home: DEMO_HOME, locks: EMPTY_LOCKS });
    return { token, customer: null, home: DEMO_HOME, locks: EMPTY_LOCKS, design, allowed: defaultAllowed(design) };
  }
  const found = await getStore().getShare(token);
  if (!found) return null;
  const row: DesignRow = found.design;
  const design = row.design ?? (await engine.design({ installer: DEFAULT_INSTALLER, home: row.home, locks: row.locks }));
  // What the installer allowed when sending, checked against the CURRENT design (the planner may have changed it
  // after sharing), so the homeowner's starting point is always one of the choices.
  const stored = found.share.allowed_variants;
  const allowed = Array.isArray(stored) && stored.length ? restrictAllowed(stored, design) : defaultAllowed(design);
  return { token, customer: row.customer_name, home: row.home, locks: { ...EMPTY_LOCKS, ...row.locks }, design, allowed };
}
