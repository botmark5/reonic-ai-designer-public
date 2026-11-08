import { cn } from "@/lib/utils";

/** Visible label + control + optional hint. Labels are never placeholders. */
export function Field({
  label,
  htmlFor,
  hint,
  children,
  className,
}: {
  label: React.ReactNode;
  htmlFor: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <label htmlFor={htmlFor} className="text-label text-ink-muted">
        {label}
      </label>
      {children}
      {hint && <p className="text-[12px] leading-4 text-ink-muted">{hint}</p>}
    </div>
  );
}

export const controlClass =
  "h-9 w-full min-w-0 rounded-sm border border-border-strong/60 bg-surface-1 px-2.5 text-body-sm text-ink transition-colors outline-none hover:border-border-strong focus-visible:border-focus focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-1 focus-visible:outline-focus/60 disabled:opacity-50 aria-invalid:border-critical";

export function TextInput(props: React.ComponentProps<"input">) {
  return <input {...props} className={cn(controlClass, "tabular", props.className)} />;
}

export function Select(props: React.ComponentProps<"select">) {
  return (
    <select
      {...props}
      className={cn(
        controlClass,
        "cursor-pointer appearance-none bg-[url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2371717a' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")] bg-[position:right_10px_center] bg-no-repeat pr-8",
        props.className,
      )}
    />
  );
}

/** Pill toggle group (single choice). */
export function Segmented<T extends string | number>({
  label,
  options,
  value,
  onChange,
  className,
}: {
  label: string;
  options: { value: T; label: React.ReactNode }[];
  value: T;
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cn("inline-flex flex-wrap gap-1 rounded-pill bg-surface-2 p-1", className)}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            className={cn(
              "h-8 cursor-pointer rounded-pill px-3 text-[13px] font-medium tabular transition-[background-color,color,box-shadow] duration-150 ease-out focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus",
              on ? "bg-surface-1 text-ink shadow-card" : "text-ink-body hover:text-ink",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
