import { beforeEach, describe, expect, it, vi } from "vitest";
import { listenOnce, resetListenOnce } from "./listen-once";

describe("listenOnce", () => {
  beforeEach(() => resetListenOnce());

  it("starts one request per offer: mount and click share it", async () => {
    const load = vi.fn(async () => ({ text: "hi" }));
    const a = listenOnce("t1", load);
    const b = listenOnce("t1", load);
    expect(await a).toEqual({ text: "hi" });
    expect(await b).toBe(await a);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("keeps a good reply for later clicks", async () => {
    const load = vi.fn(async () => ({ text: "hi" }));
    await listenOnce("t1", load);
    await listenOnce("t1", load);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("forgets a failure so the click can try again", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("503")).mockResolvedValueOnce({ text: "ok" });
    expect(await listenOnce("t1", load)).toBeNull();
    expect(await listenOnce("t1", load)).toEqual({ text: "ok" });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("forgets a null reply (not ok) too", async () => {
    const load = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ text: "ok" });
    expect(await listenOnce("t1", load)).toBeNull();
    expect(await listenOnce("t1", load)).toEqual({ text: "ok" });
  });

  it("keeps offers apart", async () => {
    const load = vi.fn(async () => ({ text: "x" }));
    await listenOnce("t1", load);
    await listenOnce("t2", load);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
