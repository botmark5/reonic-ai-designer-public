import type { ThemeName } from "./types";

/**
 * Scene colours. A real, softly coloured house (warm plaster, anthracite roof, green lawn) in a muted palette that
 * still reads on a projector; the energy system keeps the component tokens from docs/design/tokens.json and the AI
 * gradient for flows, and the panels stay dark blue-black.
 */
export interface Palette {
  surface0: string;
  surface1: string;
  border: string;
  ink: string;
  inkMuted: string;
  // energy system (tokens)
  pv: string;
  battery: string;
  heatpump: string;
  wallbox: string;
  /** AI gradient for energy flows: amber → orange → salmon. */
  flow: readonly [string, string, string];
  // model materials
  board: string;
  boardEdge: string;
  /** Indoor floors (the Inside diorama). */
  floor: string;
  street: string;
  paving: string;
  wall: string;
  plinth: string;
  roof: string;
  roofEdge: string;
  trim: string;
  glass: string;
  door: string;
  tree: string;
  trunk: string;
  car: string;
  carGlass: string;
  tyre: string;
  appliance: string;
  panel: string;
  panelFrame: string;
  // light
  sky: string;
  groundBounce: string;
}

const LIGHT: Palette = {
  surface0: "#fdfdfb",
  surface1: "#ffffff",
  border: "#e4e4e7",
  ink: "#1b1d20",
  inkMuted: "#71717a",
  pv: "#e9a23b",
  battery: "#2f9fd0",
  heatpump: "#d4604a",
  wallbox: "#52525b",
  flow: ["#e9a23b", "#ef8a4c", "#ec8a7c"],
  board: "#a3ba8c", // lawn
  boardEdge: "#8f7a62", // soil edge of the base plate
  floor: "#e6e1d8", // screed
  street: "#c9c6c0",
  paving: "#e2ddd3",
  wall: "#f1e6d4", // warm plaster
  plinth: "#b9b1a6",
  roof: "#5f6268", // anthracite tiles
  roofEdge: "#45474c",
  trim: "#fbfaf7",
  glass: "#7f97aa",
  door: "#7a5238", // oak
  tree: "#6f9a5b",
  trunk: "#7a5c45",
  car: "#d7dde3",
  carGlass: "#5d6b78",
  tyre: "#3f3f46",
  appliance: "#fbfbfa",
  panel: "#0e141e",
  panelFrame: "#b9bdc4",
  sky: "#ffffff",
  groundBounce: "#dfe6d3",
};

const DARK: Palette = {
  ...LIGHT,
  surface0: "#121315",
  surface1: "#1b1d20",
  border: "#2e3035",
  ink: "#f4f4f5",
  inkMuted: "#8b8b94",
  pv: "#eaa94a",
  battery: "#6cc8ef",
  heatpump: "#ef9a8e",
  wallbox: "#a1a1aa",
  flow: ["#eaa94a", "#f0955c", "#ef9a8e"],
  board: "#2f3d27",
  boardEdge: "#3a3027",
  floor: "#2b2a28",
  street: "#2a2b2d",
  paving: "#34322f",
  sky: "#c9d2e0",
  groundBounce: "#2a2723",
};

export function getPalette(theme: ThemeName): Palette {
  return theme === "dark" ? DARK : LIGHT;
}
