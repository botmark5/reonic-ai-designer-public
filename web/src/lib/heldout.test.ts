import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const heldout = vi.fn();
vi.mock("./engine", () => ({ engine: { heldout: (...a: unknown[]) => heldout(...a) } }));

const empty = mkdtempSync(path.join(tmpdir(), "heldout-empty-"));
const full = mkdtempSync(path.join(tmpdir(), "heldout-full-"));
writeFileSync(path.join(full, "test_ids.json"), JSON.stringify({ test_project_ids: ["f1", "f2"] }));
writeFileSync(path.join(full, "demo_projects.json"), JSON.stringify({ projects: [{ role: "ev_wallbox", why: "w", project_id: "f1", extra: 1 }] }));

describe("held-out projects", () => {
  beforeEach(() => {
    vi.resetModules();
    heldout.mockReset();
    delete process.env.HELDOUT_PROJECT_IDS;
  });
  afterEach(() => delete process.env.ENGINE_ARTIFACTS_DIR);

  it("reads the local engine artifacts when they exist", async () => {
    process.env.ENGINE_ARTIFACTS_DIR = full;
    const { heldOutIds, demoProjects } = await import("./heldout");
    expect(await heldOutIds()).toEqual(["f1", "f2"]);
    expect(await demoProjects()).toEqual([{ role: "ev_wallbox", why: "w", project_id: "f1" }]);
    expect(heldout).not.toHaveBeenCalled();
  });

  it("asks the engine when the files are missing (Vercel), once for ids and demos", async () => {
    process.env.ENGINE_ARTIFACTS_DIR = empty;
    heldout.mockResolvedValue({ test_project_ids: ["e1"], demo_projects: [{ role: "typical_pv_battery", why: "t", project_id: "e1" }] });
    const { heldOutIds, demoProjects } = await import("./heldout");
    expect(await heldOutIds()).toEqual(["e1"]);
    expect(await demoProjects()).toEqual([{ role: "typical_pv_battery", why: "t", project_id: "e1" }]);
    expect(heldout).toHaveBeenCalledTimes(1);
  });

  it("returns nothing (no invented cases) when files and engine both fail", async () => {
    process.env.ENGINE_ARTIFACTS_DIR = empty;
    heldout.mockRejectedValue(new Error("404"));
    const { heldOutIds, demoProjects } = await import("./heldout");
    expect(await heldOutIds()).toEqual([]);
    expect(await demoProjects()).toEqual([]);
  });

  it("HELDOUT_PROJECT_IDS still wins for the ids", async () => {
    process.env.ENGINE_ARTIFACTS_DIR = full;
    process.env.HELDOUT_PROJECT_IDS = "x1, x2";
    const { heldOutIds } = await import("./heldout");
    expect(await heldOutIds()).toEqual(["x1", "x2"]);
  });
});
