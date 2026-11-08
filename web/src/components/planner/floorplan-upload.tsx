"use client";

import { useEffect, useRef, useState } from "react";
import { FileUp, X } from "lucide-react";
import { toast } from "sonner";
import type { FloorPlan } from "@/lib/floorplan";

const ACCEPT = "image/png,image/jpeg,image/webp,application/pdf";

/** "Upload floor plan": sends the drawing to POST /api/floorplan (Claude vision) and hands the rooms to the 3D Inside view.
 *  Layout only: the energy design does not change. */
export function FloorPlanUpload({ plan, onPlan }: { plan: FloorPlan | null; onPlan: (p: FloorPlan | null) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [reading, setReading] = useState(false);
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!reading) return;
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [reading]);

  async function upload(file: File) {
    setSeconds(0);
    setReading(true);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch("/api/floorplan", { method: "POST", body });
      const j = (await res.json().catch(() => null)) as { floorPlan?: FloorPlan; error?: string } | null;
      if (!res.ok || !j?.floorPlan) throw new Error(j?.error ?? "Please try again.");
      onPlan(j.floorPlan);
      const n = j.floorPlan.rooms.length;
      toast.success("Floor plan read", { description: `${n} room${n === 1 ? "" : "s"} on ${j.floorPlan.widthM} × ${j.floorPlan.depthM} m. See the Inside view.` });
    } catch (e) {
      toast.error("Could not read the floor plan", { description: (e as Error).message });
    } finally {
      setReading(false);
    }
  }

  const pill = "inline-flex h-9 items-center gap-1.5 rounded-pill border px-3.5 text-body-sm transition-colors";
  return (
    <>
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) upload(f);
        }}
      />
      {plan ? (
        <span className={`${pill} border-border bg-surface-1 text-ink`}>
          <FileUp className="size-4 text-ink-muted" strokeWidth={1.5} aria-hidden />
          Floor plan · {plan.rooms.length} rooms
          <button
            type="button"
            onClick={() => onPlan(null)}
            aria-label="Remove floor plan"
            className="-mr-1.5 ml-0.5 inline-flex size-6 cursor-pointer items-center justify-center rounded-full text-ink-muted hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-focus/60"
          >
            <X className="size-3.5" strokeWidth={1.5} aria-hidden />
          </button>
        </span>
      ) : (
        <button
          type="button"
          disabled={reading}
          aria-busy={reading}
          onClick={() => input.current?.click()}
          className={`${pill} cursor-pointer border-border bg-surface-1 text-ink-body hover:text-ink disabled:cursor-wait disabled:opacity-70 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-1 focus-visible:outline-focus/60`}
        >
          <FileUp className="size-4" strokeWidth={1.5} aria-hidden />
          {reading ? `Reading your floor plan… ${seconds} s` : "Upload floor plan"}
        </button>
      )}
      {reading && (
        <span role="status" className="text-[12px] text-ink-muted">
          Claude reads the rooms and sizes: this takes about 30 seconds.
        </span>
      )}
    </>
  );
}
