"use client";

import { useState } from "react";
import { roofFromSolarResult, type StageLocation } from "@/components/house3d";
import { BuildingDesign } from "@/components/visit/building-design";
import { VisitForm, type VisitSubmit } from "@/components/visit/visit-form";
import type { StepKey, VisitStep } from "@/components/visit/visit-logic";
import type { FloorPlan } from "@/lib/floorplan";
import { savePendingFloorPlan } from "@/lib/floorplan-handoff";
import type { SolarResult } from "@/lib/solar";
import type { DesignResponse, Home } from "@/lib/types";
import type { VisitResult } from "@/lib/visit";

const ORDER: StepKey[] = ["house", "model", "panels", "parts", "ready"];
const fresh = (): VisitStep[] => ORDER.map((key, i) => ({ key, state: i === 0 ? "active" : "waiting" }));

function partsLine(d: DesignResponse): string {
  const g = d.design;
  const parts = [
    g.battery.include && g.battery.kwh ? `${g.battery.kwh} kWh battery` : "no battery",
    g.wallbox.include ? "wallbox" : "no wallbox",
    g.heatpump.include ? `${g.heatpump.kw} kW heat pump` : d.options?.heatpump?.available ? `heat pump as an option (${d.options.heatpump.kw} kW)` : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

/** /visit: the installer's phone form → each build step lights up when it really completes → draft in the planner. */
export function VisitPage() {
  const [phase, setPhase] = useState<"form" | "building">("form");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [steps, setSteps] = useState<VisitStep[]>(fresh);
  const [result, setResult] = useState<{ design: DesignResponse; home: Home } | null>(null);
  const [solar, setSolar] = useState<SolarResult | null>(null);
  const [openHref, setOpenHref] = useState<string | null>(null);

  const step = (key: StepKey, state: VisitStep["state"], detail?: string) =>
    setSteps((all) => {
      const next = all.map((s) => (s.key === key ? { ...s, state, detail } : s));
      // the next waiting step becomes active as soon as one is done
      const i = ORDER.indexOf(key);
      if (state === "done" && i + 1 < ORDER.length && next[i + 1].state === "waiting") next[i + 1] = { ...next[i + 1], state: "active" };
      return next;
    });

  async function submit({ facts, floorplan }: VisitSubmit) {
    const address = String(facts.address ?? "").trim();
    setBusy(true);
    setError(null);
    setSteps(fresh());
    setPhase("building");

    // The floor plan reads in parallel (about 30 s); it is handed to the planner when it arrives.
    const plan: Promise<FloorPlan | null> = floorplan
      ? (async () => {
          const body = new FormData();
          body.append("file", floorplan);
          const r = await fetch("/api/floorplan", { method: "POST", body }).catch(() => null);
          return r?.ok ? (((await r.json()) as { floorPlan?: FloorPlan }).floorPlan ?? null) : null;
        })()
      : Promise.resolve(null);

    // 1 + 2: the house from its satellite location, then the 3D model (Google 3D tiles or the drawn house).
    const s = (await fetch(`/api/solar?address=${encodeURIComponent(address)}`)
      .then((r) => (r.ok ? (r.json() as Promise<SolarResult>) : null))
      .catch(() => null)) as SolarResult | null;
    const geocoded = !!s && Number.isFinite(s.lat) && Number.isFinite(s.lng);
    if (!geocoded) {
      step("house", "failed", "Address not found. Check street, number and town.");
      setBusy(false);
      return;
    }
    setSolar(s);
    step("house", "done", s.status === "ok" ? `${s.segments.length} roof faces measured from the satellite image` : "Address found; Google has no roof model here");
    step("model", "done", s.status === "ok" ? "3D model from the roof faces" : "Drawn house (no 3D roof data)");

    // 3 + 4 + 5: the engine designs it and the draft is stored (one planner draft, source "form").
    const res = await fetch("/api/visit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ facts }) }).catch(() => null);
    const body = (await res?.json().catch(() => null)) as (VisitResult & { error?: string }) | null;
    if (!res?.ok || !body?.design) {
      step("panels", "failed", body?.error ?? "The design engine is not reachable right now.");
      setBusy(false);
      return;
    }
    setResult({ design: body.design, home: body.home });
    const g = body.design.design;
    const panels = g.pv.include && g.pv.kwp ? Math.round(g.pv.kwp / 0.45) : 0;
    step("panels", "done", panels ? `${panels} panels · ${g.pv.kwp} kWp on the best roof faces` : "No new panels (solar already on the roof)");
    step("parts", "done", partsLine(body.design));
    const href = `/?d=${body.design_id}`;

    if (floorplan) {
      step("ready", "active", "Reading the floor plan… (about 30 s)");
      const p = await plan;
      if (p) savePendingFloorPlan(body.design_id, p);
      step("ready", "done", p ? `Floor plan: ${p.rooms.length} rooms, shown in the planner's Inside view` : "Draft is in the planner inbox (the floor plan could not be read)");
    } else {
      step("ready", "done", "In the planner inbox as “From site visit”");
    }
    setOpenHref(href);
    setBusy(false);
  }

  const location: StageLocation | undefined =
    solar && Number.isFinite(solar.lat) && Number.isFinite(solar.lng) ? { lat: solar.lat as number, lng: solar.lng as number } : undefined;

  return (
    <div className="mx-auto w-full max-w-md px-4 py-4">
      {phase === "form" ? (
        <VisitForm busy={busy} error={error} onSubmit={submit} />
      ) : (
        <>
          <BuildingDesign
            steps={steps}
            design={result?.design ?? null}
            home={result?.home ?? null}
            location={location}
            roof={roofFromSolarResult(solar) ?? undefined}
            openHref={openHref}
          />
          {steps.some((s) => s.state === "failed") && (
            <button
              type="button"
              onClick={() => setPhase("form")}
              className="mt-2 h-12 w-full cursor-pointer rounded-pill border border-border bg-surface-1 text-[16px] font-medium text-ink"
            >
              Back to the form
            </button>
          )}
        </>
      )}
    </div>
  );
}
