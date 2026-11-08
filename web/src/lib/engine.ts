/**
 * Engine client: SERVER ONLY (route handlers, server components, server actions).
 *
 * Talks to the Python engine (engine/README.md, docs/api.md) at ENGINE_URL with header `X-Engine-Key: ENGINE_API_KEY`
 * (ENGINE_KEY also accepted).
 * The key never reaches the browser: this module imports "server-only", and browsers call /api/engine/* instead.
 *
 * Never breaks the demo: if ENGINE_URL is unset, or the engine fails / does not answer in time, the call is answered
 * by the offline estimate (lib/engine-mock.ts) and the response carries `served: { source: "offline", reason }`.
 * After a connection failure the engine is skipped for COOLDOWN_MS, so the UI stays fast while the tunnel is down.
 */
import "server-only";
import {
  MOCK_EVAL,
  mockDesign,
  mockExplanation,
  mockRefine,
  mockValidate,
  textStream,
} from "./engine-mock";
import type {
  DesignRequest,
  DesignResponse,
  EvalResponse,
  ExplainRequest,
  HealthResponse,
  ProjectResponse,
  RefineRequest,
  RefineResponse,
  Served,
  ValidateRequest,
  ValidateResponse,
} from "./types";

export { DEFAULT_INSTALLER } from "./engine-mock";

/** Per-endpoint time budgets (ms). /design answers in well under a second; /refine and /explain call Claude. */
export const TIMEOUTS = {
  design: 4000,
  validate: 4000,
  eval: 4000,
  project: 8000, // runs a full design too
  refine: 20000, // Claude Haiku + design; the first structured-output call after an engine start can take ~25 s (warmed up at start-up since #60)
  explain: 8000, // time to the response headers; the stream itself may run longer
  health: 3000,
} as const;
const COOLDOWN_MS = 15000;

export interface EngineClient {
  design(req: DesignRequest): Promise<DesignResponse>;
  validate(req: ValidateRequest): Promise<ValidateResponse>;
  refine(req: RefineRequest): Promise<RefineResponse>;
  /** Streamed plain-text explanation. */
  explain(req: ExplainRequest): Promise<{ stream: ReadableStream<Uint8Array>; served: Served }>;
  eval(): Promise<EvalResponse>;
  /** Held-out test ids and the curated demo cases (engine #94), for hosts without engine/artifacts. Throws when absent. */
  heldout(): Promise<{ test_project_ids?: string[]; demo_projects?: { role: string; why: string; project_id: string }[] }>;
  /** Real held-out projects only: throws on an unknown id or when the engine is unreachable (an invented project would mislead). */
  project(id: string, opts?: { answered?: boolean }): Promise<ProjectResponse>;
  /** What each installer sells (GET /installers, keyed by installer id). Throws when the engine is unreachable. */
  installers(): Promise<Record<string, { battery_kwh?: number[] }>>;
}

export class EngineError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "EngineError";
  }
}

export function engineUrl(): string | undefined {
  const url = process.env.ENGINE_URL;
  return url ? url.replace(/\/+$/, "") : undefined;
}

/** ENGINE_API_KEY (engine/README.md name) or ENGINE_KEY. Server env only, never NEXT_PUBLIC_. */
export function engineKey(): string | undefined {
  return process.env.ENGINE_API_KEY || process.env.ENGINE_KEY || undefined;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------
let downUntil = 0;
let downReason = "";

/** Fetch with a deadline for the response headers. The body (e.g. a stream) is not cut off. */
async function engineFetch(path: string, timeoutMs: number, init?: RequestInit): Promise<Response> {
  const base = engineUrl();
  if (!base) throw new EngineError(0, "ENGINE_URL not set");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new EngineError(0, `timeout after ${timeoutMs} ms`)), timeoutMs);
  try {
    const res = await fetch(`${base}${path}`, {
      ...init,
      signal: ctrl.signal,
      cache: "no-store",
      headers: {
        "content-type": "application/json",
        ...(engineKey() ? { "X-Engine-Key": engineKey()! } : {}),
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      let detail = res.statusText;
      try {
        const body = await res.json();
        detail = typeof body?.detail === "string" ? body.detail : JSON.stringify(body?.detail ?? body);
      } catch {}
      throw new EngineError(res.status, `${path} → ${res.status} ${detail}`);
    }
    return res;
  } catch (e) {
    if (ctrl.signal.aborted && ctrl.signal.reason instanceof EngineError) throw ctrl.signal.reason;
    if (e instanceof EngineError) throw e;
    throw new EngineError(0, `${path} unreachable: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Connection-level failures (timeout, tunnel down, 5xx, bad key) put the engine on cooldown. */
function isOutage(e: EngineError) {
  return e.status === 0 || e.status >= 500 || e.status === 401 || e.status === 403;
}

/** Input errors (400, 404, 422) are the caller's to fix: pass them through instead of hiding them behind the estimate. */
const INPUT_ERRORS = [400, 404, 422];

async function withFallback<T extends object>(
  live: () => Promise<T>,
  offline: () => T,
  opts: { passthrough?: number[] } = {},
): Promise<T & { served: Served }> {
  const t0 = Date.now();
  const off = (reason: string) => ({ ...offline(), served: { source: "offline" as const, reason, ms: Date.now() - t0 } });
  if (!engineUrl()) return off("ENGINE_URL not set");
  if (Date.now() < downUntil) return off(`engine unavailable (${downReason}); retrying in ${Math.ceil((downUntil - Date.now()) / 1000)} s`);
  try {
    const data = await live();
    downUntil = 0;
    return { ...data, served: { source: "engine", ms: Date.now() - t0 } };
  } catch (err) {
    const e = err instanceof EngineError ? err : new EngineError(0, String(err));
    if (opts.passthrough?.includes(e.status) || INPUT_ERRORS.includes(e.status)) throw e;
    if (isOutage(e)) {
      downUntil = Date.now() + COOLDOWN_MS;
      downReason = e.message;
    }
    console.warn(`[engine] offline estimate used: ${e.message}`);
    return off(e.message);
  }
}

const postJson = async <T>(path: string, body: unknown, timeoutMs: number) =>
  (await engineFetch(path, timeoutMs, { method: "POST", body: JSON.stringify(body) })).json() as Promise<T>;
const getJson = async <T>(path: string, timeoutMs: number) => (await engineFetch(path, timeoutMs)).json() as Promise<T>;

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------
export const engine: EngineClient = {
  design: (req) => withFallback(() => postJson<DesignResponse>("/design", req, TIMEOUTS.design), () => mockDesign(req)),
  validate: (req) =>
    withFallback(() => postJson<ValidateResponse>("/validate", req, TIMEOUTS.validate), () => mockValidate(req)),
  refine: (req) => withFallback(() => postJson<RefineResponse>("/refine", req, TIMEOUTS.refine), () => mockRefine(req)),
  explain: async (req) => {
    const r = await withFallback(
      async () => ({ stream: (await engineFetch("/explain", TIMEOUTS.explain, { method: "POST", body: JSON.stringify(req) })).body! }),
      () => ({ stream: textStream(mockExplanation(req)) }),
    );
    return { stream: r.stream, served: r.served };
  },
  eval: () => withFallback(() => getJson<EvalResponse>("/eval", TIMEOUTS.eval), () => MOCK_EVAL),
  heldout: () => getJson("/heldout", TIMEOUTS.eval),
  installers: () => getJson("/installers", TIMEOUTS.health),
  project: async (id, opts) => {
    if (!engineUrl()) throw new EngineError(503, "Engine not configured: held-out projects need the live engine.");
    const t0 = Date.now();
    // engine #47: `?answered=true` builds our design with the planner's existing-solar answer (what-if)
    const query = opts?.answered ? "?answered=true" : "";
    const data = await getJson<ProjectResponse>(`/project/${encodeURIComponent(id)}${query}`, TIMEOUTS.project);
    return { ...data, served: { source: "engine" as const, ms: Date.now() - t0 } };
  },
};

/** @deprecated kept for milestone-1 callers; use `engine`. */
export const getEngine = () => engine;

/** GET /health (no key). Never throws. */
export async function engineHealth(): Promise<{ ok: boolean; url: string | null; ms: number; health?: HealthResponse; error?: string }> {
  const t0 = Date.now();
  const url = engineUrl() ?? null;
  if (!url) return { ok: false, url, ms: 0, error: "ENGINE_URL not set" };
  try {
    const health = await getJson<HealthResponse>("/health", TIMEOUTS.health);
    return { ok: health.status === "ok", url, ms: Date.now() - t0, health };
  } catch (e) {
    return { ok: false, url, ms: Date.now() - t0, error: (e as Error).message };
  }
}

/** The example home from docs/api.md, used by the health check. */
export const EXAMPLE_DESIGN_REQUEST: DesignRequest = {
  installer: "installer_a",
  home: {
    annual_kwh: 4500, price_eur_kwh: 0.32, load_profile: "H0", has_ev: false, ev_km_year: null,
    existing_pv_kwp: null, existing_battery_kwh: null, heating: "Gas", heating_demand_kwh: null,
    roof_type: null, house_sqm: null, inhabitants: null,
  },
  locks: { pv_kwp: null, battery_kwh: null, wallbox: null, heatpump_kw: null },
};
