/**
 * Held-out projects for the reality check. SERVER ONLY.
 * Source: the engine's locked test set (engine/artifacts/test_ids.json, generated from the Reonic data, never committed)
 * and its curated demo set (engine/artifacts/demo_projects.json). On a host without those files (Vercel) the same
 * lists come from the engine's GET /heldout (engine issue #94); HELDOUT_PROJECT_IDS (comma-separated) still overrides
 * the ids. Directory override: ENGINE_ARTIFACTS_DIR. Nothing is invented when every source fails.
 */
import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { engine } from "./engine";

export interface DemoProject {
  role: string;
  why: string;
  project_id: string;
}

const dir = () => process.env.ENGINE_ARTIFACTS_DIR || path.resolve(process.cwd(), "../engine/artifacts");

async function readJson<T>(name: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path.join(dir(), name), "utf8")) as T;
  } catch {
    return null;
  }
}

type HeldOut = { test_project_ids?: string[]; demo_projects?: DemoProject[] };
let fromEngine: Promise<HeldOut | null> | null = null;
/** One engine call per server instance; a failure is retried on the next request. */
function engineHeldOut(): Promise<HeldOut | null> {
  fromEngine ??= engine.heldout().catch(() => {
    fromEngine = null;
    return null;
  });
  return fromEngine;
}
const clean = (list: DemoProject[] | undefined) => (list ?? []).map(({ role, why, project_id }) => ({ role, why, project_id }));

export async function heldOutIds(): Promise<string[]> {
  const env = process.env.HELDOUT_PROJECT_IDS?.split(",").map((s) => s.trim()).filter(Boolean);
  if (env?.length) return env;
  const t = await readJson<{ test_project_ids?: string[] }>("test_ids.json");
  if (t?.test_project_ids?.length) return t.test_project_ids;
  return (await engineHeldOut())?.test_project_ids ?? [];
}

export async function demoProjects(): Promise<DemoProject[]> {
  const d = await readJson<{ projects?: DemoProject[] }>("demo_projects.json");
  if (d?.projects?.length) return clean(d.projects);
  return clean((await engineHeldOut())?.demo_projects);
}
