import { cn } from "@/lib/utils";

export type Tone = "ai" | "success" | "warning" | "critical" | "neutral";

const TONE: Record<Tone, { wrap: string; dot: string }> = {
  ai: { wrap: "bg-ai-tint text-ai-text", dot: "bg-ai-orange" },
  success: { wrap: "bg-success-tint text-success-text", dot: "bg-success" },
  warning: { wrap: "bg-warning-tint text-warning-text", dot: "bg-warning" },
  critical: { wrap: "bg-critical-tint text-critical-text", dot: "bg-critical" },
  neutral: { wrap: "bg-surface-2 text-ink-body", dot: "bg-ink-muted" },
};

/** State = a dot + a word + a colour, never colour alone (docs/design/README.md). */
export function StatusBadge({
  tone = "neutral",
  children,
  className,
  pulse,
  title,
}: {
  tone?: Tone;
  children: React.ReactNode;
  className?: string;
  pulse?: boolean;
  title?: string;
}) {
  const t = TONE[tone];
  return (
    <span
      title={title}
      className={cn(
        "inline-flex h-6 items-center gap-1.5 rounded-pill px-2.5 text-label whitespace-nowrap",
        t.wrap,
        className,
      )}
    >
      <span className={cn("relative size-1.5 shrink-0 rounded-full", t.dot)} aria-hidden>
        {pulse && <span className={cn("absolute inset-0 animate-ping rounded-full motion-reduce:hidden", t.dot)} />}
      </span>
      {children}
    </span>
  );
}
