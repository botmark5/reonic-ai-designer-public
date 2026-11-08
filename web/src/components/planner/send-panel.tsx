"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { currentValues, defaultAllowed, type AllowedComponent, type AllowedVariant } from "@/lib/allowed";
import { fmtKwp } from "@/lib/format";
import type { DesignResponse } from "@/lib/types";
import { cn } from "@/lib/utils";

const same = (a: number | boolean, b: number | boolean) => (typeof a === "number" && typeof b === "number" ? Math.abs(a - b) < 0.01 : a === b);

function label(c: AllowedComponent, v: number | boolean): string {
  if (c === "pv") return `${fmtKwp(v as number)} kWp`;
  if (c === "battery") return v === 0 ? "No battery" : `${v} kWh`;
  if (c === "wallbox") return v ? "With charger" : "Without charger";
  return v ? "Add heat pump" : "No heat pump";
}

const TITLE: Record<AllowedComponent, string> = { pv: "Solar size", battery: "Battery", wallbox: "Car charger", heatpump: "Heat pump option" };

/**
 * "Send to homeowner": the installer picks what the homeowner may change on the offer page. Prefilled with everything
 * the engine offers (its alternatives); the proposal itself is always included. The server narrows it again.
 */
export function SendPanel({
  design,
  busy,
  onSend,
  onCancel,
}: {
  design: DesignResponse;
  busy: boolean;
  onSend: (allowed: AllowedVariant[]) => void;
  onCancel: () => void;
}) {
  const all = defaultAllowed(design);
  const cur = currentValues(design);
  const [picked, setPicked] = useState<AllowedVariant[]>(all);
  const isOn = (c: AllowedComponent, v: number | boolean) => picked.find((a) => a.component === c)?.values.some((x) => same(x, v)) ?? false;
  const toggle = (c: AllowedComponent, v: number | boolean) =>
    setPicked((p) =>
      p.map((a) => (a.component !== c ? a : { ...a, values: isOn(c, v) ? a.values.filter((x) => !same(x, v)) : [...a.values, v] })),
    );
  const rows = all.filter((a) => a.values.length > 1);

  return (
    <section aria-label="What the homeowner may change" className="flex flex-col gap-3 rounded-md border border-border bg-surface-1 p-4">
      <div className="flex flex-col gap-0.5">
        <h2 className="m-0 text-[15px] font-semibold">What the homeowner may change</h2>
        <p className="m-0 text-[13px] text-ink-muted">Your proposal is always shown. Untick what you don&apos;t want them to choose.</p>
      </div>
      {rows.length === 0 && <p className="m-0 text-[13px] text-ink-muted">The engine offered no alternatives for this home: the homeowner sees your proposal only.</p>}
      {rows.map((a) => (
        <div key={a.component} className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
          <span className="w-36 shrink-0 text-[13px] font-medium text-ink-body">{TITLE[a.component]}</span>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label={TITLE[a.component]}>
            {a.values.map((v) => {
              const proposal = same(v, cur[a.component]);
              const on = proposal || isOn(a.component, v);
              return (
                <button
                  key={String(v)}
                  type="button"
                  aria-pressed={on}
                  disabled={proposal}
                  title={proposal ? "Your proposal: always shown" : undefined}
                  onClick={() => toggle(a.component, v)}
                  className={cn(
                    "h-8 cursor-pointer rounded-pill border px-3 text-[13px] transition-colors focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-1 focus-visible:outline-focus/60 disabled:cursor-default",
                    on ? "border-ink bg-ink text-surface-0" : "border-dashed border-border-strong bg-surface-1 text-ink-body hover:text-ink",
                  )}
                >
                  {label(a.component, v)}
                  {proposal ? " ★" : ""}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => onSend(picked)} disabled={busy}>
          Copy homeowner link
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </section>
  );
}
