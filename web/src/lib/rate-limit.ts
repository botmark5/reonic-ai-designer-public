/** Small in-memory sliding-window limiter per client (per server instance; enough to blunt abuse in a demo). */
const hits = new Map<string, number[]>();

export function clientKey(req: Request): string {
  return (req.headers.get("x-forwarded-for")?.split(",")[0] ?? req.headers.get("x-real-ip") ?? "local").trim();
}

export function allowRequest(bucket: string, client: string, max: number, windowMs: number): boolean {
  const key = `${bucket}:${client}`;
  const now = Date.now();
  const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (list.length >= max) {
    hits.set(key, list);
    return false;
  }
  list.push(now);
  hits.set(key, list);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
  return true;
}

/** Reads a JSON body, refusing anything larger than maxBytes. */
export async function readJsonCapped<T>(req: Request, maxBytes: number): Promise<T | null> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > maxBytes) return null;
  const text = await req.text();
  if (text.length > maxBytes) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
