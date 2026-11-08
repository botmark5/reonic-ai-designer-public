import type { Served } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Shown when a number came from the built-in offline estimate instead of the engine (tunnel down, ENGINE_URL unset).
 * Renders nothing for engine answers. Shape + word + colour, never colour alone.
 */
export function ServedBadge({ served, className }: { served?: Served | null; className?: string }) {
  if (!served || served.source === "engine") return null;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-pill bg-warning-tint px-2 py-0.5 text-label whitespace-nowrap text-warning-text",
        className,
      )}
      title={`The engine did not answer (${served.reason ?? "unknown"}). These numbers are a rule-of-thumb estimate.`}
    >
      <span className="size-1.5 rounded-full bg-warning" aria-hidden />
      Offline estimate
    </span>
  );
}
