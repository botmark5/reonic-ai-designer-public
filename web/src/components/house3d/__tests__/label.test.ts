import { describe, expect, it } from "vitest";
import { placeLabel } from "../Tooltip";

describe("placeLabel (labels stay inside narrow stages)", () => {
  it("moves a right label above its anchor (slid inwards) near the right edge", () => {
    expect(placeLabel("right", 500, 130, 566)).toEqual({ side: "above", shift: -7 });
    expect(placeLabel("right", 200, 130, 566)).toEqual({ side: "right", shift: 0 });
  });
  it("moves a left label above near the left edge", () => {
    expect(placeLabel("left", 60, 130, 566)).toEqual({ side: "above", shift: 13 });
  });
  it("slides an above label inwards at either edge", () => {
    expect(placeLabel("above", 40, 120, 566)).toEqual({ side: "above", shift: 28 });
    expect(placeLabel("above", 540, 120, 566)).toEqual({ side: "above", shift: -42 });
    expect(placeLabel("above", 283, 120, 566)).toEqual({ side: "above", shift: 0 });
  });
});
