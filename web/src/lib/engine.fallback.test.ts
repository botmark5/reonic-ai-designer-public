import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesignResponse } from "./types";

const load = async () => {
  vi.resetModules();
  return import("./engine");
};

const fakeDesign = { design: { pv: { include: true, kwp: 9.45 } }, model_version: "v1" } as unknown as DesignResponse;

describe("engine client fallback", () => {
  beforeEach(() => {
    vi.stubEnv("ENGINE_URL", "https://engine.test/");
    vi.stubEnv("ENGINE_KEY", "test-key");
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("uses the offline estimate when ENGINE_URL is unset", async () => {
    vi.stubEnv("ENGINE_URL", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { engine, EXAMPLE_DESIGN_REQUEST } = await load();
    const r = await engine.design(EXAMPLE_DESIGN_REQUEST);
    expect(r.served).toMatchObject({ source: "offline", reason: "ENGINE_URL not set" });
    expect(r.model_version).toBe("MOCK");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("calls the engine with the X-Engine-Key header and marks the answer as engine", async () => {
    const fetchMock = vi.fn(async () => Response.json(fakeDesign));
    vi.stubGlobal("fetch", fetchMock);
    const { engine, EXAMPLE_DESIGN_REQUEST } = await load();
    const r = await engine.design(EXAMPLE_DESIGN_REQUEST);
    expect(r.served?.source).toBe("engine");
    expect(r.design.pv.kwp).toBe(9.45);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://engine.test/design");
    expect((init.headers as Record<string, string>)["X-Engine-Key"]).toBe("test-key");
  });

  it("falls back after 4 s without an answer, then skips the engine during the cooldown", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason))),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { engine, EXAMPLE_DESIGN_REQUEST } = await load();
    const pending = engine.design(EXAMPLE_DESIGN_REQUEST);
    await vi.advanceTimersByTimeAsync(3999);
    let settled = false;
    pending.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    const r = await pending;
    expect(r.served).toMatchObject({ source: "offline", reason: "timeout after 4000 ms" });
    expect(r.model_version).toBe("MOCK");

    const again = await engine.design(EXAMPLE_DESIGN_REQUEST);
    expect(again.served?.source).toBe("offline");
    expect(again.served?.reason).toMatch(/retrying in/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back on a wrong key (401) and on network errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ detail: "Missing or wrong X-Engine-Key header." }, { status: 401 })));
    const { engine, EXAMPLE_DESIGN_REQUEST } = await load();
    const r = await engine.design(EXAMPLE_DESIGN_REQUEST);
    expect(r.served?.source).toBe("offline");
    expect(r.served?.reason).toContain("401");

    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    const m2 = await load();
    const r2 = await m2.engine.design(EXAMPLE_DESIGN_REQUEST);
    expect(r2.served?.reason).toContain("unreachable");
  });

  it("does not invent a project for an unknown id (404 passes through)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ detail: "Unknown project 'x'" }, { status: 404 })));
    const { engine, EngineError } = await load();
    await expect(engine.project("x")).rejects.toBeInstanceOf(EngineError);
  });

  it("surfaces input errors (422) instead of hiding them behind the estimate", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ detail: "heating: bad value" }, { status: 422 })));
    const { engine, EngineError, EXAMPLE_DESIGN_REQUEST } = await load();
    await expect(engine.design(EXAMPLE_DESIGN_REQUEST)).rejects.toBeInstanceOf(EngineError);
  });

  it("never serves an invented held-out project when the engine is not configured", async () => {
    vi.stubEnv("ENGINE_URL", "");
    const { engine } = await load();
    await expect(engine.project("abc")).rejects.toMatchObject({ status: 503 });
  });
});
