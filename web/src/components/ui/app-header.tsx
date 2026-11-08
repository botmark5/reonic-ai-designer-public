import { Suspense } from "react";
import { AppNav, Brand } from "./app-nav";

function Logo() {
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/brand/reonic-logo.svg" alt="Reonic" width={107} height={22} className="h-[22px] w-auto" />
    </>
  );
}

/** Planner pages: logo + "AI Designer" + main nav. Homeowner pages (/offer): logo only, no planner navigation. */
export function AppHeader() {
  return (
    <header className="sticky top-0 z-30 border-b border-border bg-surface-0/90 backdrop-blur-md">
      <div className="mx-auto flex h-14 w-full max-w-[1600px] items-center gap-3 px-4 md:gap-6 md:px-6">
        <Suspense fallback={<span className="flex shrink-0 items-center"><Logo /></span>}>
          <Brand logo={<Logo />} />
        </Suspense>
        <Suspense fallback={null}>
          <AppNav />
        </Suspense>
      </div>
    </header>
  );
}
