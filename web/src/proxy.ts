import { NextResponse, type NextRequest } from "next/server";
import { AUTH_COOKIE, authToken, plannerPasscode, safeEqual } from "@/lib/auth";

/**
 * Planner pages and planner APIs need the planner cookie (when PLANNER_PASSCODE is set).
 * Public: the homeowner offer (/offer, /api/offer), login, engine health, and session D's voice/solar routes
 * (they authenticate themselves with their own secrets), and static assets incl. the homeowner offer's audio (mp3).
 */
export async function proxy(req: NextRequest) {
  const pass = plannerPasscode();
  if (!pass) return NextResponse.next();
  const cookie = req.cookies.get(AUTH_COOKIE)?.value ?? "";
  if (cookie && safeEqual(cookie, await authToken(pass))) return NextResponse.next();

  const { pathname, search } = req.nextUrl;
  if (pathname.startsWith("/api/")) return NextResponse.json({ error: "Sign in as a planner first." }, { status: 401 });
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = `?next=${encodeURIComponent(pathname + search)}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: [
    "/((?!offer|api/offer|api/voice|api/solar|api/engine/health|login|api/login|_next/static|_next/image|brand|models|favicon\\.ico|.*\\.(?:png|svg|jpg|webp|glb|ico|mp3)$).*)",
  ],
};
