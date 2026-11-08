export type { Design, DesignResponse, Home } from "../../lib/types";

/** Who is looking: the planner gets exact sizes, the homeowner plain words. */
export type House3DMode = "planner" | "homeowner";

/**
 * Roof facts that override `home.tilt_deg` / `home.orientation_deg` (e.g. from Google Solar).
 * Defaults: 35° pitch, 180° (south).
 */
export interface RoofInput {
  pitchDeg?: number;
  azimuthDeg?: number;
  /** Upper bound on panels the roof can take (Google Solar maxArrayPanelsCount). */
  maxPanels?: number;
  /** Where the house is, for the sun's path (default Munich). */
  latitude?: number;
  longitude?: number;
}

export type ThemeName = "light" | "dark";

/** A part of the system the stage can highlight or report as selected (same keys as the planner's cards). */
export type ComponentKey = "pv" | "battery" | "inverter" | "wallbox" | "heatpump";

/** Where the house stands. Only for real addresses the planner entered; never geocode Reonic project data. */
export interface StageLocation {
  lat: number;
  lng: number;
  address?: string;
}

/** Build-up steps for the /live reveal. A step that is false (or missing) is not drawn yet. */
export interface StageReveal {
  shell?: boolean;
  roof?: boolean;
  /** Panels already on the roof (retrofits). Default: with `panels`. */
  existingPv?: boolean;
  /** New panels drop in row by row when this turns true. */
  panels?: boolean;
  /** Inverter on the garage wall. Default: with the first panels (new or existing). */
  inverter?: boolean;
  /** Battery modules stack in one by one (≈2.5 kWh each). Default: with `panels`. */
  battery?: boolean;
  /** The car drives in (only if the design has a wallbox). */
  car?: boolean;
  /** Heat pump appears as a ghost first, then solid. If the design only offers it as an option, it stays a ghost. */
  heatpump?: boolean;
  /** Windows glow warm (the household's consumption is known). Look only. */
  warm?: boolean;
}

/**
 * One panel as the planner placed it on the model roof: its centre in metres on the roof plane, u along the eave
 * from the plane's centre (negative = left), v up the slope from the eave. segment 0 = main roof, 1 = garage roof.
 * Moving panels never changes the engine's size.
 */
export interface StagePanel {
  id: string;
  segment: number;
  u: number;
  v: number;
  portrait: boolean;
}

export type StageView = "outside" | "inside";
/**
 * "full": time bar + readout under the model, camera presets (and planner tools) over it.
 * "time": time bar + readout under the model, NOTHING over it (homeowner /offer).
 * "minimal": camera presets only. "none": the model alone.
 */
export type StageControls = "full" | "time" | "minimal" | "none";
