"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/", label: "Designs", short: "Designs" },
  { href: "/live", label: "Live call", short: "Live" },
  { href: "/reality", label: "Reality check", short: "Reality" },
] as const;

const isHomeowner = (path: string) => path.startsWith("/offer");

/** Logo: links to the planner on planner pages; plain on homeowner pages. */
export function Brand({ logo }: { logo: React.ReactNode }) {
  const path = usePathname();
  if (isHomeowner(path))
    return (
      <span className="flex shrink-0 items-center gap-2.5">
        {logo}
        <span className="hidden text-body-sm font-medium text-ink-muted sm:inline">Your offer</span>
      </span>
    );
  return (
    <Link href="/" className="flex shrink-0 items-center gap-2.5 rounded-sm" aria-label="Reonic AI Designer, designs">
      {logo}
      <span className="hidden text-body-sm font-medium text-ink-muted sm:inline">AI Designer</span>
    </Link>
  );
}

export function AppNav() {
  const path = usePathname();
  // homeowners never see planner navigation; on /login every link would only lead back here
  if (isHomeowner(path) || path.startsWith("/login")) return null;
  return (
    <nav aria-label="Main" className="flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
      {LINKS.map((l) => {
        const active = l.href === "/" ? path === "/" : path.startsWith(l.href);
        return (
          <Link
            key={l.href}
            href={l.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "rounded-pill px-2.5 py-1.5 text-body-sm sm:px-3 whitespace-nowrap transition-colors duration-150",
              active ? "bg-surface-2 font-medium text-ink" : "text-ink-body hover:bg-surface-2/60 hover:text-ink",
            )}
          >
            {/* short labels on phones so all three fit at 390 px */}
            <span className="sm:hidden">{l.short}</span>
            <span className="hidden sm:inline">{l.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
