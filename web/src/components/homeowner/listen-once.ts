/**
 * One "Listen" request per offer per page load. The page starts it on mount (so the clip is ready before the
 * click); the click awaits the same promise. A failed request is forgotten, so the click can try again once.
 * Module scope, so a remount (or React's dev double effect) never starts a second paid generation.
 */
const inflight = new Map<string, Promise<unknown>>();

export function listenOnce<T>(token: string, load: () => Promise<T | null>): Promise<T | null> {
  const hit = inflight.get(token) as Promise<T | null> | undefined;
  if (hit) return hit;
  const p = load()
    .catch(() => null)
    .then((r) => {
      if (r == null) inflight.delete(token);
      return r;
    });
  inflight.set(token, p);
  return p;
}

/** Tests only. */
export function resetListenOnce() {
  inflight.clear();
}
