"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { HouseStage, roofFromSolarResult, type ComponentKey as StageKey, type StageLocation } from "@/components/house3d";
import { Button } from "@/components/ui/button";
import { ServedBadge } from "@/components/ui/served-badge";
import { StatusBadge } from "@/components/ui/status-badge";
import { COMPONENTS, sizeOf } from "@/lib/diff";
import { roofInputsFromSolar } from "@/lib/roof";
import type { SolarResult } from "@/lib/solar";
import type { DesignRow } from "@/lib/supabase";
import { OFFER_TYPE_LABEL, type ComponentKey, type DesignResponse, type OfferType } from "@/lib/types";
import type { InsideKey, Zone } from "@/components/house3d/insideRules";
import type { FloorPlan } from "@/lib/floorplan";
import { clearPendingFloorPlan, readPendingFloorPlan } from "@/lib/floorplan-handoff";
import { FloorPlanUpload } from "./floorplan-upload";
import type { AllowedVariant } from "@/lib/allowed";
import { HomeForm, type AddressLookup } from "./home-form";
import { SendPanel } from "./send-panel";
import { Inbox } from "./inbox";
import { PhysicsTiles, SimilarHomes, WhyThisDesign } from "./evidence";
import { FocusPanel } from "./focus-panel";
import { RefineBox } from "./refine-box";
import { SystemCard } from "./system-card";
import { homeTitle } from "./text";
import { usePlanner } from "./use-planner";

/** Floating 3D labels only where there is room for them (they crowd the house on a phone). */
const WIDE = "(min-width: 768px)";
function useWide() {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(WIDE);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => window.matchMedia(WIDE).matches,
    () => true,
  );
}

export function PlannerApp({ designs, initial }: { designs: DesignRow[]; initial: DesignRow }) {
  const [rows, setRows] = useState(designs);
  const [current, setCurrent] = useState(initial);
  const known = useRef(new Set(designs.map((d) => d.id)));
  const selectRef = useRef<((row: DesignRow) => void) | null>(null);

  // Inbox: poll the server (authenticated) for new and updated designs; announce new voice drafts.
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/designs", { cache: "no-store" });
        if (!res.ok || stop) return;
        const list = (await res.json()) as DesignRow[];
        for (const row of list) {
          if (known.current.has(row.id)) continue;
          known.current.add(row.id);
          if (row.source === "voice" || row.source === "form")
            toast(row.source === "voice" ? "New design from a call" : "New design from a site visit", { description: homeTitle(row), action: { label: "Open", onClick: () => selectRef.current?.(row) } });
        }
        setRows(list);
      } catch {}
    };
    const t = setInterval(tick, 4000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);

  const select = useCallback(async (row: DesignRow) => {
    window.history.replaceState(null, "", `/?d=${row.id}`);
    const res = await fetch(`/api/designs/${row.id}`);
    setCurrent(res.ok ? ((await res.json()) as DesignRow) : row);
  }, []);
  useEffect(() => {
    selectRef.current = select;
  }, [select]);

  const createNew = useCallback(async (name: string, address?: string) => {
    const res = await fetch("/api/designs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ customer_name: name, address: address?.trim() || null }),
    });
    if (!res.ok) return toast.error("Could not create the design");
    const row = (await res.json()) as DesignRow;
    known.current.add(row.id);
    setRows((r) => [row, ...r]);
    window.history.replaceState(null, "", `/?d=${row.id}`);
    setCurrent(row);
  }, []);

  return (
    <div className="mx-auto grid w-full max-w-[1600px] grid-cols-[minmax(0,1fr)] gap-6 px-4 py-6 md:px-6 lg:grid-cols-[264px_minmax(0,1fr)] xl:grid-cols-[272px_minmax(0,1fr)_336px]">
      {/* key: a fresh planner state per selected design */}
      <Workspace key={current.id} row={current} rows={rows} onSelect={select} onNew={createNew} />
    </div>
  );
}

function Workspace({
  row,
  rows,
  onSelect,
  onNew,
}: {
  row: DesignRow;
  rows: DesignRow[];
  onSelect: (r: DesignRow) => void;
  onNew: (name: string, address?: string) => void;
}) {
  const p = usePlanner(row);
  const { s } = p;
  const r = s.response;
  const changed = new Set(s.change?.diff.changed ?? []);
  const offerType = r?.facts_for_explanation?.offer_type as OfferType | undefined;
  const lockedCount = Object.values(s.locks).filter((v) => v !== null && v !== undefined).length;

  // Google Solar for the customer's address: roof cap, direction and pitch go into /design (once; the planner can
  // edit or remove them in the form), and the real roof goes to the 3D house. Nothing happens without a result.
  const [solar, setSolar] = useState<SolarResult | null>(null);
  const { applyRoof, setHome } = p;
  // The address to look up: the row's (from a call or New home), or one the planner typed ("Find house").
  const [address, setAddress] = useState(row.address?.trim() ?? "");
  const [lookupRun, setLookupRun] = useState(0); // bumps on every "Find house", so the same address can be retried
  const [lookup, setLookup] = useState<AddressLookup>("idle");
  const typed = useRef(false); // a typed address replaces the roof inputs; a stored one only fills them when empty
  useEffect(() => {
    if (!address) return;
    const ctrl = new AbortController();
    fetch(`/api/solar?address=${encodeURIComponent(address)}`, { signal: ctrl.signal })
      .then((res) => (res.ok ? (res.json() as Promise<SolarResult>) : null))
      .then((res) => {
        if (ctrl.signal.aborted) return;
        // /api/solar answers 200 with a status: only "ok" is a house with a roof model. A geocode without roof data
        // still places the house on the map.
        const geocoded = !!res && Number.isFinite(res.lat) && Number.isFinite(res.lng);
        if (!res || (res.status !== "ok" && !geocoded)) {
          if (typed.current) {
            setLookup("notfound");
            toast.error("Address not found", { description: "Try street, number and city, e.g. Musterstraße 80, München." });
          }
          return;
        }
        setSolar(res);
        const roof = roofInputsFromSolar(res);
        if (typed.current) {
          setLookup(res.status === "ok" ? "found" : "noroof");
          if (res.status === "ok")
            toast.success("House found", { description: roof?.roof_max_kwp ? `The roof fits about ${roof.roof_max_kwp} kWp. The 3D view shows the real street.` : "The 3D view shows the real street." });
          else toast("Address found, no roof data", { description: "Google has no 3D roof model here; the design keeps your roof inputs." });
        }
        if (roof) (typed.current ? setHome : applyRoof)(roof);
      })
      .catch(() => {
        if (!ctrl.signal.aborted && typed.current) {
          setLookup("notfound");
          toast.error("Could not look the address up", { description: "Check the connection and try again." });
        }
      });
    return () => ctrl.abort();
  }, [address, lookupRun, applyRoof, setHome]);
  const findHouse = useCallback(
    (a: string) => {
      typed.current = true;
      setLookup("looking");
      setSolar(null);
      setAddress(a);
      setLookupRun((n) => n + 1);
      fetch(`/api/designs/${row.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: a }) }).catch(() => {});
    },
    [row.id],
  );
  const roof3d = useMemo(() => roofFromSolarResult(solar), [solar]);
  // Only a real address the planner has (geocoded by /api/solar) puts the house on the map; never Reonic project data.
  const location = useMemo<StageLocation | undefined>(
    () =>
      solar && Number.isFinite(solar.lat) && Number.isFinite(solar.lng)
        ? { lat: solar.lat as number, lng: solar.lng as number, address: address || undefined }
        : undefined,
    [solar, address],
  );
  const [sunMap, setSunMap] = useState(false);
  // Floor plan per design (layout for the Inside view only), kept while the planner is open.
  // A floor plan read on /visit for this draft comes via session storage (client navigation from /visit).
  const [plans, setPlans] = useState<Record<string, FloorPlan>>(() => {
    const p = typeof window === "undefined" ? null : readPendingFloorPlan(row.id);
    return p ? { [row.id]: p } : {};
  });
  useEffect(() => clearPendingFloorPlan(row.id), [row.id]); // read once; a reload must render the same on server and client
  const floorPlan = plans[row.id] ?? null;
  const setFloorPlan = useCallback(
    (p: FloorPlan | null) =>
      setPlans((all) => {
        const next = { ...all };
        if (p) next[row.id] = p;
        else delete next[row.id];
        return next;
      }),
    [row.id],
  );

  // Card ↔ house: hovering a card highlights its part on the house; clicking a part on the house points at its card.
  const [hovered, setHovered] = useState<ComponentKey | null>(null);
  const [picked, setPicked] = useState<ComponentKey | null>(null);
  const [focusBefore, setFocusBefore] = useState<DesignResponse | null>(null);
  const [zones, setZones] = useState<Partial<Record<InsideKey, Zone>>>({});
  // Click a part on the house → its focus panel (want it, where, which size, what changes) next to the house.
  const onStageSelect = useCallback((key: StageKey | null) => {
    const c: ComponentKey | null = key === "inverter" ? "pv" : key;
    setPicked(c);
    setFocusBefore(null);
    if (c) requestAnimationFrame(() => document.getElementById("focus-panel")?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
  }, []);
  const onCardHover = useCallback((c: ComponentKey | null) => {
    setHovered(c);
    if (c) setPicked(null);
  }, []);
  const title = homeTitle(row);
  // After a change, let the house animate first, then bring the first changed card's value into view (the hero moment:
  // "PV 10.35 → 11.7 kWp" on the card) if it sits below the fold. Instant with reduced motion; never scrolls up.
  const changeKey = s.change?.id;
  const firstChanged = s.change?.diff.changed[0];
  useEffect(() => {
    if (!changeKey || !firstChanged) return;
    const t = setTimeout(() => {
      const el = document.getElementById(`card-${firstChanged}`);
      if (!el) return;
      const overflow = el.getBoundingClientRect().top + 150 - window.innerHeight;
      if (overflow <= 0) return;
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      window.scrollBy({ top: overflow + 16, behavior: reduce ? "auto" : "smooth" });
    }, 900);
    return () => clearTimeout(t);
  }, [changeKey, firstChanged]);
  const wide = useWide();

  const [sending, setSending] = useState<"closed" | "open" | "busy">("closed");
  async function send(allowed: AllowedVariant[]) {
    setSending("busy");
    const res = await p.share(allowed);
    setSending(res ? "closed" : "open");
    if (!res) return;
    const url = `${window.location.origin}${res.path}`;
    await navigator.clipboard?.writeText(url).catch(() => {});
    toast.success("Homeowner link copied", { description: url, action: { label: "Open", onClick: () => window.open(res.path, "_blank") } });
  }

  return (
    <>
      <aside className="order-3 flex min-w-0 flex-col gap-5 lg:order-1 lg:row-span-2" aria-label="Inbox and inputs">
        <Inbox rows={rows} selectedId={row.id} onSelect={onSelect} onNew={onNew} />
        <fieldset disabled={s.refining} className="m-0 min-w-0 border-0 p-0 disabled:opacity-60" aria-describedby={s.refining ? "refining-note" : undefined}>
          <HomeForm home={s.home} onChange={p.setHome} address={address} lookup={lookup} onFindHouse={findHouse} />
        </fieldset>
        {s.refining && <p id="refining-note" className="m-0 -mt-3 text-[12px] text-ink-muted">Inputs are paused while the designer updates the design.</p>}
      </aside>

      <main id="main" className="order-1 flex min-w-0 flex-col gap-4 lg:order-2">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge tone="ai">{row.source === "voice" ? "Drafted by AI from a call" : row.source === "form" ? "Drafted by AI from a site visit" : "Drafted by AI"}</StatusBadge>
              {lockedCount > 0 && <StatusBadge tone="neutral">{lockedCount === 1 ? "1 choice by you" : `${lockedCount} choices by you`}</StatusBadge>}
              <ServedBadge served={r?.served} />
            </div>
            <h1 className="m-0 text-h1 [overflow-wrap:anywhere] sm:truncate" title={row.address && row.address !== title ? `${title} · ${row.address}` : title}>
              {title}
            </h1>
            <p className="m-0 text-body-sm text-ink-muted">
              {offerType && OFFER_TYPE_LABEL[offerType] ? <span className="font-medium text-ink-body">{OFFER_TYPE_LABEL[offerType]} · </span> : null}
              Proposed from this installer&apos;s past offers
              {r?.model_version && r.served?.source !== "offline" ? ` · model ${r.model_version.split(" ")[0]}` : ""}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" render={<Link href="/reality" />} nativeButton={false}>
              Compare with expert
            </Button>
            <Button variant="secondary" onClick={() => setSending((v) => (v === "closed" ? "open" : "closed"))} disabled={!r} aria-expanded={sending !== "closed"}>
              Send to homeowner
            </Button>
            <Button
              onClick={() => {
                p.setStatus("review");
                toast.success("Design saved as the offer", { description: `${title} is ready to send.` });
              }}
              disabled={!r || s.row.status !== "draft"}
            >
              {s.row.status === "draft" ? "Use this design" : s.row.status === "review" ? "Ready to send" : "Sent"}
            </Button>
          </div>
        </div>

        {r && sending !== "closed" && <SendPanel design={r} busy={sending === "busy"} onSend={send} onCancel={() => setSending("closed")} />}

        {r ? (
          <section aria-label="The system on the house" className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              {location && (
                <button
                  type="button"
                  aria-pressed={sunMap}
                  onClick={() => setSunMap((v) => !v)}
                  className={`h-9 cursor-pointer rounded-pill border px-3.5 text-body-sm transition-colors ${sunMap ? "border-comp-pv bg-[color-mix(in_srgb,var(--comp-pv)_14%,var(--surface-1))] font-medium text-ink" : "border-border bg-surface-1 text-ink-body hover:text-ink"}`}
                >
                  Sun map
                </button>
              )}
              <FloorPlanUpload plan={floorPlan} onPlan={setFloorPlan} />
            </div>
            <HouseStage
              // floorPlan: rooms for the Inside view (c-3d's prop; layout only, never a size)
              {...{ floorPlan }}
              design={r}
              home={s.home}
              mode="planner"
              roof={roof3d}
              location={location}
              sunMap={sunMap}
              editable
              highlight={hovered ?? picked}
              onSelect={onStageSelect}
              // the camera zooms to the part whose focus panel is open (c-3d #140); closing the panel zooms back out
              focus={picked}
              zones={zones as Partial<Record<ComponentKey, Zone>>}
              onZonesChange={(z) => setZones(z as Partial<Record<InsideKey, Zone>>)}
              labels={wide}
              // the readout and time bar would push the refine box and cards below the fold at 1440 × 900; the same
              // numbers are in the evidence column
              controls="minimal"
              className="md:[&_[data-h3d-stage]]:aspect-video"
            />
          </section>
        ) : (
          <div className="aspect-[4/3] w-full animate-pulse rounded-lg border border-border bg-surface-1 motion-reduce:animate-none md:aspect-video" aria-hidden />
        )}

        <RefineBox home={s.home} locks={s.locks} onResult={p.applyRefine} onStart={() => p.setRefining(true)} onEnd={() => p.setRefining(false)} showExamples={!s.change} />

        <div aria-live="polite" className="empty:hidden">
          {!s.busy && s.change && (s.change.diff.lines.length > 0 || s.change.note) && (
            <p key={s.change.id} className="m-0 flex flex-wrap items-center gap-2 text-[13px] text-ink-body animate-in fade-in motion-safe:slide-in-from-top-1 duration-300">
              <span className="rounded-sm bg-highlight px-2 py-0.5 font-medium text-[#1b1d20]">Changed</span>
              {s.change.diff.lines.length > 0 && <span className="font-mono tabular">{s.change.diff.lines.join(" · ")}</span>}
              {s.change.note && <span>{s.change.diff.lines.length > 0 ? "· " : ""}{s.change.note}</span>}
            </p>
          )}
          {s.busy && r && (
            <p className="m-0 flex items-center gap-2 text-[13px] text-ink-muted">
              <span className="size-1.5 animate-pulse rounded-full bg-ai-orange motion-reduce:animate-none" aria-hidden />
              Recalculating with the engine…
            </p>
          )}
          {!s.busy && s.error && <p className="m-0 text-[13px] text-critical-text">{s.error} Your last design is still shown.</p>}
        </div>

        {r ? (
          <fieldset disabled={s.refining} className={`m-0 grid min-w-0 grid-cols-1 gap-4 border-0 p-0 sm:grid-cols-2 ${s.busy || s.refining ? "opacity-70 transition-opacity" : ""}`}>
            {COMPONENTS.map((c) => (
              <SystemCard
                key={c}
                component={c}
                response={r}
                locks={s.locks}
                flags={s.flags}
                changed={changed.has(c)}
                changeId={s.change?.id ?? 0}
                busy={s.busy}
                onLock={(v, reason) => p.setLock(c, v, reason)}
                before={s.change?.before ? sizeOf(s.change.before, c) : undefined}
                highlighted={picked === c}
                onHover={onCardHover}
              />
            ))}
          </fieldset>
        ) : null}
        {!r && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2" aria-busy="true" aria-label="Designing">
            {COMPONENTS.map((c) => (
              <div key={c} className="h-64 animate-pulse rounded-md border border-border bg-surface-1 motion-reduce:animate-none" />
            ))}
          </div>
        )}
      </main>

      <aside className="order-2 flex min-w-0 flex-col gap-4 lg:order-3 lg:col-start-2 xl:col-start-3 xl:row-start-1" aria-label="Evidence">
        {r && picked && (
          <FocusPanel
            key={picked}
            component={picked}
            response={r}
            before={focusBefore}
            busy={s.busy}
            zones={zones}
            onZones={setZones}
            onLock={(v, reason) => {
              setFocusBefore(r);
              p.setLock(picked, v, reason ?? undefined);
            }}
            onClose={() => {
              setPicked(null);
              setFocusBefore(null);
            }}
          />
        )}
        <WhyThisDesign response={r} />
        {r && <SimilarHomes response={r} />}
        {r && <PhysicsTiles response={r} flags={s.flags} />}
      </aside>
    </>
  );
}
