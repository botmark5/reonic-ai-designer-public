"use client";

import Link from "next/link";
import { AlertTriangle, ArrowRight, Check } from "lucide-react";
import { HouseStage, type RoofInput, type StageLocation } from "@/components/house3d";
import { Button } from "@/components/ui/button";
import type { DesignResponse, Home } from "@/lib/types";
import { cn } from "@/lib/utils";
import { revealFromSteps, STEP_LABEL, type VisitStep } from "./visit-logic";

/**
 * After the site-visit form: five steps that light up as each one really completes (the parent sets them), with the
 * house assembling in step: shell when the house is found, warm windows with the model, panels, then the other parts.
 */
export function BuildingDesign({
  steps,
  design,
  home,
  location,
  roof,
  openHref,
}: {
  steps: VisitStep[];
  design: DesignResponse | null;
  home: Home | null;
  location?: StageLocation;
  roof?: RoofInput;
  /** The draft in the planner; shown as the action once the last step is done. */
  openHref: string | null;
}) {
  const rv = revealFromSteps(steps);
  const ready = steps.some((s) => s.key === "ready" && s.state === "done");
  const failed = steps.find((s) => s.state === "failed");

  return (
    <div className="flex flex-col gap-5 pb-8">
      <header className="flex flex-col gap-1.5 px-1 pt-2">
        <p className="m-0 text-[13px] font-medium text-ink-muted" aria-live="polite">
          {ready ? "Done" : failed ? "Stopped" : "Working"}
        </p>
        <h1 className="m-0 text-[28px] leading-[1.1] font-normal tracking-[-0.02em]">{ready ? "Your draft is ready" : "Building your design"}</h1>
      </header>

      <div className="-mx-4 overflow-hidden border-y border-border bg-surface-1 sm:mx-0 sm:rounded-lg sm:border">
        {design && home ? (
          <HouseStage
            design={design}
            home={home}
            mode="planner"
            roof={roof}
            location={location}
            reveal={{
              shell: rv.shell,
              roof: rv.roof,
              warm: rv.warm,
              existingPv: rv.shell,
              panels: rv.panels,
              inverter: rv.inverter,
              battery: rv.parts,
              car: rv.parts,
              heatpump: rv.parts,
            }}
            controls="none"
            labels={false}
            className="[&_[data-h3d-stage]]:aspect-[4/3]"
          />
        ) : (
          <div className="grid aspect-[4/3] place-items-center" aria-hidden>
            <div className="size-24 animate-pulse rounded-lg bg-surface-2 motion-reduce:animate-none" />
          </div>
        )}
      </div>

      <ol className="m-0 flex list-none flex-col gap-0 p-0" aria-label="Steps">
        {steps.map((s, i) => (
          <li key={s.key} className="relative flex gap-3.5 pb-4 last:pb-0">
            {/* the line to the next step fills in once this one is done */}
            {i < steps.length - 1 && (
              <span aria-hidden className="absolute top-8 bottom-0 left-[13px] w-0.5 overflow-hidden rounded-full bg-border">
                <span className={cn("block h-full w-full origin-top bg-primary transition-transform duration-500 ease-out motion-reduce:transition-none", s.state === "done" ? "scale-y-100" : "scale-y-0")} />
              </span>
            )}
            <Dot state={s.state} n={i + 1} />
            <div className="flex min-w-0 flex-col pt-0.5">
              <span className={cn("text-[16px] leading-6 transition-colors duration-300", s.state === "waiting" ? "text-ink-muted" : "font-medium text-ink")}>{STEP_LABEL[s.key]}</span>
              {s.detail && <span className={cn("text-[13px] leading-[18px]", s.state === "failed" ? "text-critical-text" : "text-ink-body")}>{s.detail}</span>}
              <span className="sr-only">{s.state === "done" ? "done" : s.state === "active" ? "in progress" : s.state === "failed" ? "failed" : "waiting"}</span>
            </div>
          </li>
        ))}
      </ol>

      {ready && openHref && (
        <Button size="lg" render={<Link href={openHref} />} nativeButton={false} className="h-13 w-full text-[16px] animate-in fade-in motion-safe:slide-in-from-bottom-1 duration-300">
          Open in planner <ArrowRight data-icon="inline-end" strokeWidth={1.75} />
        </Button>
      )}
    </div>
  );
}

function Dot({ state, n }: { state: VisitStep["state"]; n: number }) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative grid size-7 shrink-0 place-items-center rounded-full text-[13px] font-medium transition-[background-color,color,box-shadow] duration-300",
        state === "done" && "bg-primary text-primary-ink",
        state === "active" && "bg-surface-1 text-ink shadow-[inset_0_0_0_2px_var(--ai-orange)]",
        state === "waiting" && "bg-surface-1 text-ink-muted shadow-[inset_0_0_0_1.5px_var(--border)]",
        state === "failed" && "bg-warning-tint text-warning-text",
      )}
    >
      {state === "done" ? (
        <Check className="size-4 animate-in zoom-in-50 duration-200 motion-reduce:animate-none" strokeWidth={2.5} />
      ) : state === "failed" ? (
        <AlertTriangle className="size-3.5" strokeWidth={2} />
      ) : (
        n
      )}
      {state === "active" && <span className="absolute inset-0 animate-ping rounded-full shadow-[inset_0_0_0_2px_var(--ai-orange)] opacity-40 motion-reduce:hidden" />}
    </span>
  );
}
