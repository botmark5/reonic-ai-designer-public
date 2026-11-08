import type { Metadata } from "next";
import { Suspense } from "react";
import Image from "next/image";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Sign in · Reonic AI Designer",
  robots: { index: false },
};

export default function LoginPage({ searchParams }: PageProps<"/login">) {
  return (
    <Suspense fallback={<main className="flex-1" />}>
      <Login searchParams={searchParams} />
    </Suspense>
  );
}

async function Login({
  searchParams,
}: {
  searchParams: PageProps<"/login">["searchParams"];
}) {
  const sp = await searchParams;
  const next = typeof sp.next === "string" ? sp.next : "/";
  return (
    <main
      id="main"
      className="grid w-full flex-1 grid-cols-1 grid-rows-[auto_1fr] lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] lg:grid-rows-1"
    >
      {/* The first frame of the demo: the house the product designs, softly behind the sign-in (a still, no 3D). */}
      <div aria-hidden className="order-first flex items-center justify-center overflow-hidden lg:order-last lg:p-10">
        <div className="relative aspect-[16/10] w-full max-w-md lg:max-w-none">
          <Image
            src="/models/house-fallback.png"
            alt=""
            fill
            priority
            sizes="(min-width: 1024px) 56vw, 100vw"
            className="object-contain mix-blend-multiply [mask-image:radial-gradient(ellipse_at_center,black_55%,transparent_75%)]"
          />
        </div>
      </div>
      <div className="mx-auto flex w-full max-w-sm flex-col justify-start gap-6 px-4 pt-2 pb-16 lg:justify-center lg:py-16">
        <div className="flex flex-col gap-2">
          <p className="m-0 text-label uppercase text-ink-muted">AI Designer</p>
          <h1 className="m-0 text-h1">Planner sign-in</h1>
          <p className="m-0 text-body-sm text-ink-muted">
            A complete PV, battery, wallbox and heat pump design from a few
            facts about a home. Customer designs are only visible to the
            installer&apos;s planners.
          </p>
        </div>
        <form method="post" action="/api/login" className="flex flex-col gap-3">
          <input type="hidden" name="next" value={next} />
          <label htmlFor="passcode" className="text-label text-ink-muted">
            Passcode
          </label>
          <input
            id="passcode"
            name="passcode"
            type="password"
            autoComplete="current-password"
            required
            autoFocus
            aria-invalid={sp.error ? true : undefined}
            aria-describedby={sp.error ? "pass-err" : undefined}
            className="h-11 rounded-sm border border-border-strong/60 bg-surface-1 px-3 text-body outline-none focus-visible:border-focus focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-1 focus-visible:outline-focus/60"
          />
          {sp.error && (
            <p
              id="pass-err"
              role="alert"
              className="m-0 text-body-sm text-critical-text"
            >
              That passcode is not right. Try again.
            </p>
          )}
          <Button type="submit" size="lg">
            Sign in
          </Button>
        </form>
      </div>
    </main>
  );
}
