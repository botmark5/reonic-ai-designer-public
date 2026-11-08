import { expect, it } from "vitest";
import { cn } from "./utils";

it("keeps token font sizes next to token colours", () => {
  expect(cn("text-label text-ink-muted")).toBe("text-label text-ink-muted");
  expect(cn("text-sm text-metric")).toBe("text-metric");
});
it("lets rounded-pill override shadcn radii", () => {
  expect(cn("rounded-lg", "rounded-pill")).toBe("rounded-pill");
});
it("resolves token colour conflicts", () => {
  expect(cn("bg-surface-2", "bg-primary")).toBe("bg-primary");
});
