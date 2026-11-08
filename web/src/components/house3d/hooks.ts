"use client";
import { useSyncExternalStore } from "react";
import type { ThemeName } from "./types";

const REDUCED = "(prefers-reduced-motion: reduce)";

function subscribeReduced(cb: () => void) {
  const mq = window.matchMedia(REDUCED);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}

/** true when the user asked for reduced motion. Server render assumes reduced (nothing moves before hydration). */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReduced, () => window.matchMedia(REDUCED).matches, () => true);
}

function subscribeTheme(cb: () => void) {
  const obs = new MutationObserver(cb);
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });
  return () => obs.disconnect();
}

/** Follows next-themes' `dark` class on <html>. */
export function useThemeName(): ThemeName {
  return useSyncExternalStore(
    subscribeTheme,
    () => (document.documentElement.classList.contains("dark") ? "dark" : "light"),
    () => "light",
  );
}
