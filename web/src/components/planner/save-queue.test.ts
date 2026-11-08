import { describe, expect, it } from "vitest";
import { createSaveQueue } from "./save-queue";

const later = (ms: number, log: string[], name: string) => () => new Promise<void>((r) => setTimeout(() => (log.push(name), r()), ms));

describe("createSaveQueue", () => {
  it("runs saves one after another, in order", async () => {
    const log: string[] = [];
    const q = createSaveQueue();
    q.push(later(20, log, "a"));
    q.push(later(1, log, "b"));
    await q.idle();
    expect(log).toEqual(["a", "b"]);
  });
  it("idle() waits for saves queued before it (share after refine)", async () => {
    const log: string[] = [];
    const q = createSaveQueue();
    q.push(later(15, log, "save"));
    await q.idle().then(() => log.push("share"));
    expect(log).toEqual(["save", "share"]);
  });
  it("a failed save does not block the next one or idle()", async () => {
    const log: string[] = [];
    const q = createSaveQueue();
    q.push(() => Promise.reject(new Error("offline")));
    q.push(later(1, log, "b"));
    await q.idle();
    expect(log).toEqual(["b"]);
  });
});
