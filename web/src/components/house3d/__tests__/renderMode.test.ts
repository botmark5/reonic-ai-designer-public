import { describe, expect, it } from "vitest";
import { chooseRenderMode } from "../renderMode";

describe("chooseRenderMode", () => {
  it("falls back to the static image when 3D would fail or hurt", () => {
    expect(chooseRenderMode({ webgl: false })).toBe("static");
    expect(chooseRenderMode({ webgl: true, saveData: true })).toBe("static");
    expect(chooseRenderMode({ webgl: true, forceStatic: true })).toBe("static");
    expect(chooseRenderMode({ webgl: true, cores: 2 })).toBe("static");
  });
  it("renders 3D on capable devices, also when cores are unknown", () => {
    expect(chooseRenderMode({ webgl: true, cores: 8 })).toBe("3d");
    expect(chooseRenderMode({ webgl: true })).toBe("3d");
  });
});
