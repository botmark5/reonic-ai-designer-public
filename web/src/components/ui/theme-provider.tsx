"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";

/** The app is pinned to the light theme (projector + one look for the demo); the system setting is ignored. */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider attribute="class" forcedTheme="light" defaultTheme="light" enableSystem={false} disableTransitionOnChange>
      {children}
    </NextThemesProvider>
  );
}
