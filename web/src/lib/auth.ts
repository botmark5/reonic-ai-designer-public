/**
 * Planner access: one shared passcode (PLANNER_PASSCODE). The cookie holds HMAC(passcode, "planner-v1"), never the
 * passcode. Web Crypto only, so it runs in proxy.ts and in route handlers. No passcode set = open (local dev).
 */
export const AUTH_COOKIE = "planner_auth";

export function plannerPasscode(): string | undefined {
  return process.env.PLANNER_PASSCODE || undefined;
}

export async function authToken(passcode: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(passcode), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("planner-v1"));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string compare. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
