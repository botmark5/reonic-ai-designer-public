/**
 * A floor plan read on /visit, handed to the planner for that draft (this browser only, session storage).
 * The planner reads it when the draft opens.
 */
import type { FloorPlan } from "./floorplan";

const key = (designId: string) => `reonic.floorplan.${designId}`;

export function savePendingFloorPlan(designId: string, plan: FloorPlan) {
  try {
    sessionStorage.setItem(key(designId), JSON.stringify(plan));
  } catch {}
}

export function readPendingFloorPlan(designId: string): FloorPlan | null {
  try {
    const raw = sessionStorage.getItem(key(designId));
    return raw ? (JSON.parse(raw) as FloorPlan) : null;
  } catch {
    return null;
  }
}

export function clearPendingFloorPlan(designId: string) {
  try {
    sessionStorage.removeItem(key(designId));
  } catch {}
}
