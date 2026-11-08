/**
 * Where the PV panels go. Pure and unit-free except metres.
 * A roof plane is a rectangle: u runs along the eave (0 = plane centre), v runs from the eave up to the ridge.
 */

/** A 450 W module in portrait, metres. */
export const PANEL = { w: 1.134, h: 1.762, gap: 0.02, kwp: 0.45 } as const;

export type PlaneId = "main" | "garage";

export interface RoofPlane {
  id: PlaneId;
  /** Length along the eave, metres. */
  width: number;
  /** Length from eave to ridge (or top edge), metres. */
  slope: number;
  margin: { side: number; eave: number; ridge: number };
}

export interface PanelSlot {
  /** Stable per position (`${plane}-r${row}u${mm}`): a panel that stays put keeps its id when the system grows. */
  id: string;
  plane: PlaneId;
  /** Panel centre, metres. */
  u: number;
  v: number;
}

/**
 * Ids of panels already on the roof start with this. A proposed panel in the same spot is a different panel: when
 * the planner flips "solar already on the roof?", the old ones lift away and the proposal drops in, instead of the
 * roof looking unchanged; the renderer also draws them in a weathered tint.
 */
export const EXISTING_ID = "existing:";
export const isExisting = (id: string) => id.startsWith(EXISTING_ID);

export interface Layout {
  slots: PanelSlot[];
  requested: number;
  placed: number;
  /** Panels that fit on no plane. */
  overflow: number;
}

/** Panels for a PV size: round(kWp / 0.45), optionally capped (e.g. by Google Solar). */
export function panelCount(kwp: number | null | undefined, maxPanels?: number): number {
  if (kwp == null || !Number.isFinite(kwp) || kwp <= 0) return 0;
  const n = Math.round(kwp / PANEL.kwp);
  return maxPanels != null && maxPanels >= 0 ? Math.min(n, Math.floor(maxPanels)) : n;
}

const fit = (length: number, size: number) => Math.max(0, Math.floor((length + PANEL.gap + 1e-9) / (size + PANEL.gap)));

export function capacity(plane: RoofPlane): { cols: number; rows: number; total: number } {
  const cols = fit(plane.width - 2 * plane.margin.side, PANEL.w);
  const rows = fit(plane.slope - plane.margin.eave - plane.margin.ridge, PANEL.h);
  return { cols, rows, total: cols * rows };
}

/**
 * Fill planes in order. On each plane: full rows from the eave up, the last row centred. A last row of only one or two
 * panels would stand alone on the roof, so then the last two rows share their panels evenly (21 on a 10-wide roof:
 * 10/6/5, not 10/10/1). More panels only ever add to the top, so a bigger design drops in new panels, not a re-layout.
 */
export function rowSizes(k: number, cols: number): number[] {
  if (cols <= 0 || k <= 0) return [];
  const sizes = Array.from({ length: Math.floor(k / cols) }, () => cols);
  const r = k % cols;
  if (r > 0) sizes.push(r);
  if (r > 0 && r <= 2 && sizes.length >= 2 && cols >= 4) {
    const pair = cols + r;
    sizes[sizes.length - 2] = Math.ceil(pair / 2);
    sizes[sizes.length - 1] = Math.floor(pair / 2);
  }
  return sizes;
}
export function layoutPanels(n: number, planes: RoofPlane[]): Layout {
  const requested = Math.max(0, Math.floor(n));
  const slots: PanelSlot[] = [];
  let left = requested;
  for (const plane of planes) {
    if (left <= 0) break;
    const { cols, total } = capacity(plane);
    const k = Math.min(left, total);
    const sizes = rowSizes(k, cols);
    for (let i = 0, row = 0; i < k; row++) {
      const inRow = Math.min(cols, sizes[row] ?? 0, k - i);
      const v = plane.margin.eave + PANEL.h / 2 + row * (PANEL.h + PANEL.gap);
      for (let col = 0; col < inRow; col++, i++) {
        const u = (col - (inRow - 1) / 2) * (PANEL.w + PANEL.gap);
        slots.push({ id: `${plane.id}-r${row}u${Math.round(u * 1000)}`, plane: plane.id, u, v });
      }
    }
    left -= k;
  }
  return { slots, requested, placed: slots.length, overflow: requested - slots.length };
}
