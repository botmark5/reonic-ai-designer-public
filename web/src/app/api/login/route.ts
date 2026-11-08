import { AUTH_COOKIE, authToken, plannerPasscode, safeEqual } from "@/lib/auth";
import { allowRequest, clientKey } from "@/lib/rate-limit";

/** POST /api/login (form: passcode, next) → sets the planner cookie and redirects. */
export async function POST(req: Request) {
  if (!allowRequest("login", clientKey(req), 10, 60_000)) return new Response("Too many attempts. Wait a minute.", { status: 429 });
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return new Response("Send the passcode as a form.", { status: 400 });
  }
  const next = String(form.get("next") ?? "/");
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/";
  const pass = plannerPasscode();
  const given = String(form.get("passcode") ?? "");
  const base = new URL(req.url);
  if (pass && !safeEqual(await authToken(given), await authToken(pass))) {
    return Response.redirect(new URL(`/login?error=1&next=${encodeURIComponent(safeNext)}`, base), 303);
  }
  const res = Response.redirect(new URL(safeNext, base), 303);
  const headers = new Headers(res.headers);
  if (pass)
    headers.append(
      "set-cookie",
      `${AUTH_COOKIE}=${await authToken(pass)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}${base.protocol === "https:" ? "; Secure" : ""}`,
    );
  return new Response(null, { status: 303, headers });
}
