"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { Check, Phone, Play, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ServedBadge } from "@/components/ui/served-badge";
import { StatusBadge } from "@/components/ui/status-badge";
import { HouseStage, roofFromSolarResult, type StageLocation, type StageReveal } from "@/components/house3d";
import { callToLive, factsToHome, heardTurns, nextHeardOrder, pretty, type Facts } from "@/app/live/facts";
import { revealFromFacts, stagedDesign, stepToward, type LiveReveal } from "@/app/live/stage";
import { agentLine, type AgentLine, type VoiceStatus } from "@/app/live/agent-status";
import { COMPONENTS, sizeOf } from "@/lib/diff";
import { fmtInt, LABEL, UNIT } from "@/lib/format";
import type { SolarResult } from "@/lib/solar";
import type { CallRow, DesignRow, TranscriptTurn } from "@/lib/supabase";
import type { ComponentKey, DesignResponse, Home } from "@/lib/types";
import { EMPTY_LOCKS } from "@/lib/types";
import { cn } from "@/lib/utils";
import { stripVoiceTags } from "@/lib/display-text";

const DOT: Record<string, string> = { pv: "bg-comp-pv", battery: "bg-comp-battery", wallbox: "bg-comp-wallbox", heatpump: "bg-comp-heatpump" };

type Chip = { key: string; done: boolean; label: string; text: React.ReactNode };

function chips(f: Facts): Chip[] {
  const list: Chip[] = [];
  if (f.address) list.push({ key: "address", done: true, label: "Address", text: <b>{f.address}</b> });
  list.push(
    {
      key: "solar",
      done: f.has_existing_pv != null || f.existing_pv_kwp != null,
      label: "Existing solar",
      text: f.has_existing_pv === false || f.existing_pv_kwp === 0 ? <>No solar yet</> : f.existing_pv_kwp ? <><b className="font-mono tabular">{f.existing_pv_kwp}</b> kWp on the roof</> : <>Solar on the roof</>,
    },
    {
      key: "use",
      done: f.annual_kwh != null || f.monthly_bill_eur != null || f.annual_kwh_estimate != null,
      label: "Yearly use",
      text:
        f.annual_kwh != null ? <><b className="font-mono tabular">{fmtInt(f.annual_kwh)}</b> kWh / year</>
        : f.monthly_bill_eur != null ? <><b className="font-mono tabular">€{fmtInt(f.monthly_bill_eur)}</b> a month</>
        : <>≈ <b className="font-mono tabular">{fmtInt(f.annual_kwh_estimate ?? 0)}</b> kWh <span className="text-warning-text">estimated</span></>,
    },
    { key: "household", done: f.household != null, label: "Household", text: <>{f.household === 1 ? "1 person" : `${f.household} people`}</> },
    {
      key: "ev",
      done: f.has_ev != null,
      label: "Electric car",
      text: f.has_ev ? <>Electric car{f.ev_km_year ? <>, <span className="font-mono tabular">{fmtInt(f.ev_km_year)}</span> km</> : null}</> : <>No electric car</>,
    },
    { key: "heating", done: f.heating != null, label: "Heating", text: <>{f.heating ? pretty(f.heating) : ""} heating{f.heating_age_years ? `, ${f.heating_age_years} yrs` : ""}</> },
    {
      key: "roof",
      done: f.roof_type != null || f.roof_direction != null,
      label: "Roof",
      text: <>{f.roof_type ? pretty(f.roof_type) : "Roof"}{f.roof_direction ? `, ${pretty(f.roof_direction).toLowerCase()}` : ""}</>,
    },
  );
  return list;
}

// --- Scripted demo call (no phone needed on stage) --------------------------------------------------------------
const SCRIPT: { role: "agent" | "customer"; text: string; facts?: Facts }[] = [
  { role: "agent", text: "Hello, I'm the planning assistant for your installer. Who am I speaking with, and where is the house?" },
  { role: "customer", text: "Weber, in Augsburg.", facts: { customer_name: "Weber, Augsburg" } },
  { role: "agent", text: "Thanks. First: is there already solar or a battery on the house?" },
  { role: "customer", text: "No, nothing yet.", facts: { has_existing_pv: false } },
  { role: "agent", text: "Roughly how much electricity do you use in a year?" },
  { role: "customer", text: "About 4,800 kilowatt hours. We're a family of four.", facts: { annual_kwh: 4800, household: 4 } },
  { role: "agent", text: "Is there an electric car, now or planned?" },
  { role: "customer", text: "We're getting one in spring, maybe 15,000 kilometres a year.", facts: { has_ev: true, ev_km_year: 15000 } },
  { role: "agent", text: "Got it, family of four with an EV from spring. Last one: what heats the house today?" },
  { role: "customer", text: "Gas boiler, about 15 years old. The roof is concrete tile, facing south.", facts: { heating: "gas", heating_age_years: 15, roof_type: "concrete_tile", roof_direction: "south" } },
  { role: "agent", text: "Perfect. I've drafted a design; your installer will check it and get back to you." },
];

function useClock(startIso: string | null, running: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  if (!startIso) return "00:00";
  const s = Math.max(0, Math.floor((now - new Date(startIso).getTime()) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

const subscribeWide = (cb: () => void) => {
  const m = window.matchMedia("(min-width: 1024px)");
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
};
/** Projector labels on the model only where the stage is big enough (lg and up). */
/** While no call runs: is the voice agent reaching us? GET /api/voice/status every 10 s (d-voice #152). */
function AgentStatusLine() {
  const [line, setLine] = useState<AgentLine | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = () =>
      fetch("/api/voice/status", { cache: "no-store" })
        .then((r) => (r.ok ? (r.json() as Promise<VoiceStatus>) : null))
        .catch(() => null)
        .then((s) => alive && setLine(agentLine(s)));
    tick();
    const t = setInterval(tick, 10_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  if (!line) return null;
  return (
    <p className="m-0 flex items-start gap-2 text-[13px] leading-[18px] text-ink-muted" aria-live="polite">
      <span aria-hidden className={cn("mt-[6px] size-1.5 shrink-0 rounded-full", line.tone === "ok" ? "bg-success" : line.tone === "warn" ? "bg-warning" : "bg-border-strong")} />
      <span className="min-w-0 line-clamp-2">{line.text}</span>
    </p>
  );
}

const useWide = () => useSyncExternalStore(subscribeWide, () => window.matchMedia("(min-width: 1024px)").matches, () => false);

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Value counts from the last shown number to the new one in 300 ms (instant with reduced motion). */
function useCountUp(target: number) {
  const [v, setV] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    const start = from.current;
    from.current = target;
    if (start === target || reducedMotion()) {
      setV(target);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / 300);
      setV(start + (target - start) * (1 - Math.pow(1 - p, 3)));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    // always land on the engine's number, even if frames are starved (busy GPU, background tab)
    const done = setTimeout(() => {
      cancelAnimationFrame(raf);
      setV(target);
    }, 450);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(done);
    };
  }, [target]);
  return v;
}

/** Catalogue PV sizes are multiples of 0.45 kWp, so show up to two decimals (9.45, 10.8) rather than rounding. */
const num = new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 2 });
const numShort = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const fmt = (c: ComponentKey, v: number) => (c === "pv" ? num.format(v) : numShort.format(v));

/** Steps land one at a time: panels need longer to drop row by row than the others. */
const STEP_MS: Partial<Record<keyof LiveReveal, number>> = { shell: 500, warm: 700, panels: 1300, battery: 900, car: 900 };

function useStagedReveal(target: LiveReveal): LiveReveal {
  const [shown, setShown] = useState<LiveReveal>(target);
  const instant = reducedMotion();
  useEffect(() => {
    if (instant) return;
    const next = stepToward(shown, target);
    if (next === shown) return;
    const added = (Object.keys(next) as (keyof LiveReveal)[]).find((k) => next[k] && !shown[k]);
    // removals (restart) apply at once; an addition waits for the previous step to land
    const t = setTimeout(() => setShown(next), added ? (STEP_MS[added] ?? 700) : 0);
    return () => clearTimeout(t);
  }, [shown, target, instant]);
  return instant ? target : shown;
}

function Metric({ c, draft, prev }: { c: ComponentKey; draft: DesignResponse; prev: DesignResponse | null }) {
  const v = sizeOf(draft.design, c);
  const hp = c === "heatpump" ? draft.options?.heatpump : undefined;
  const option = c === "heatpump" && v == null && hp?.available ? hp.kw : null;
  const shownTarget = v ?? option ?? 0;
  const shown = useCountUp(shownTarget);
  const before = prev ? sizeOf(prev.design, c) : undefined;
  const changed = before !== undefined && before !== v;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="flex items-center gap-2 text-[13px] text-ink-muted">
        <span className={cn("size-2 shrink-0 rounded-full", DOT[c])} aria-hidden />
        {LABEL[c]}
        {option != null && <span className="rounded-full bg-surface-2 px-1.5 text-[11px] leading-4 font-medium text-ink-body">Option</span>}
      </dt>
      <dd className={cn("m-0 flex items-baseline gap-1.5 font-mono tabular", v == null && option == null && "text-ink-muted")}>
        <span key={`${v}-${option}`} className="-mx-1 animate-value-changed px-1 text-[clamp(22px,2.2vw,30px)] leading-none font-medium">
          {v == null && option == null ? <span className="font-sans text-[17px] font-normal">None</span> : fmt(c, shown)}
        </span>
        {(v != null || option != null) && <span className="text-[13px] text-ink-muted">{UNIT[c]}</span>}
      </dd>
      <span className={cn("h-4 font-mono text-[12px] leading-4 tabular text-ink-muted", !changed && "invisible")}>
        {changed ? <>was {before == null ? "none" : fmt(c, before)}</> : "·"}
      </span>
    </div>
  );
}

export function LiveCall({ quoteFont }: { quoteFont?: string }) {
  const [mode, setMode] = useState<"idle" | "real" | "demo">("idle");
  const [call, setCall] = useState<CallRow | null>(null);
  const [savedDraft, setSavedDraft] = useState<DesignResponse | null>(null);
  // drafts belong to one call: a new call (or a restart) starts from an empty house
  const [drafts, setDrafts] = useState<{ callId: string; draft: DesignResponse | null; prev: DesignResponse | null }>({ callId: "", draft: null, prev: null });
  const [draftRowId, setDraftRowId] = useState<string | null>(null);
  // demo state
  const [demoStep, setDemoStep] = useState(0);
  const [demoStart, setDemoStart] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const designAbort = useRef<AbortController | null>(null);
  // arrival order of the caller's answers (jsonb loses it), per call
  const [heardOrder, setHeardOrder] = useState<{ callId: string; order: string[] }>({ callId: "", order: [] });

  // Poll real calls every 2 s (server route; calls are not readable from the browser). With update_facts on the
  // voice agent, each answer lands in calls.facts while the caller speaks.
  useEffect(() => {
    if (mode === "demo") return;
    let stop = false;
    const tick = async () => {
      try {
        const r = await fetch("/api/calls", { cache: "no-store" });
        if (!r.ok) return;
        const { calls, latestDesign } = (await r.json()) as { calls: CallRow[]; latestDesign: DesignRow | null };
        const latest = calls[0];
        const fresh = latest && Date.now() - new Date(latest.created_at).getTime() < 45 * 60_000;
        if (stop) return;
        if (fresh) {
          setMode("real");
          setCall(latest);
          const f = (latest.facts ?? {}) as { stated?: Record<string, unknown>; updated_fields?: string[] };
          setHeardOrder((prev) =>
            prev.callId === latest.id
              ? { callId: prev.callId, order: nextHeardOrder(prev.order, f.stated, f.updated_fields) }
              : { callId: latest.id, order: nextHeardOrder([], f.stated, f.updated_fields) },
          );
          setSavedDraft(latestDesign?.design ?? null);
          setDraftRowId(latestDesign?.id ?? null);
        }
      } catch {}
    };
    tick();
    const t = setInterval(tick, 2000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [mode]);

  const demoFacts: Facts = useMemo(() => SCRIPT.slice(0, demoStep).reduce((acc, t) => ({ ...acc, ...(t.facts ?? {}) }), {}), [demoStep]);
  const demoDone = demoStep >= SCRIPT.length;

  // Demo: advance the script.
  useEffect(() => {
    if (mode !== "demo" || demoDone) return;
    const prev = SCRIPT[demoStep - 1];
    const t = setTimeout(() => setDemoStep((s) => s + 1), demoStep === 0 ? 400 : Math.min(3200, 900 + (prev?.text.length ?? 40) * 28));
    return () => clearTimeout(t);
  }, [mode, demoStep, demoDone]);

  // real call: chips from the caller's answers, the engine home d-voice derived (same as create_design)
  const real = useMemo(() => (call ? callToLive(call) : null), [call]);
  const facts: Facts = mode === "demo" ? demoFacts : (real?.facts ?? {});
  const engineHome: Home = mode === "demo" ? factsToHome(demoFacts) : (real?.home ?? factsToHome({}));
  const ready = mode === "demo" ? demoFacts.annual_kwh != null : !!real?.ready;
  const factsKey = JSON.stringify(engineHome) + JSON.stringify(facts);
  const spokenAt = mode === "real" ? real?.updatedAt : undefined;
  const callId = mode === "demo" ? `demo-${demoStart}` : (call?.id ?? "idle");

  // Draft as soon as consumption is known; re-draft whenever the facts change (demo and real calls alike).
  useEffect(() => {
    if (mode === "idle" || !ready) return;
    designAbort.current?.abort();
    const ctrl = new AbortController();
    designAbort.current = ctrl;
    const t0 = performance.now();
    fetch("/api/engine/design", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ installer: "installer_a", home: engineHome, locks: EMPTY_LOCKS }),
      signal: ctrl.signal,
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: DesignResponse | null) => {
        if (!d || ctrl.signal.aborted) return;
        // latency: engine round trip, and (real calls) from the server storing the answer to the draft on screen
        const sinceSpoken = spokenAt ? ` · answer stored → draft ${Math.round(Date.now() - new Date(spokenAt).getTime())} ms` : "";
        console.info(`[live] facts → draft ${Math.round(performance.now() - t0)} ms${sinceSpoken}`);
        setDrafts((old) => ({ callId, draft: d, prev: old.callId === callId ? old.draft : null }));
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, factsKey, callId]);

  const draft = drafts.callId === callId ? drafts.draft : null;
  const prevDraft = drafts.callId === callId ? drafts.prev : null;

  const startDemo = useCallback(() => {
    setMode("demo");
    setCall(null);
    setSavedDraft(null);
    setDraftRowId(null);
    setSent(null);
    setDemoStep(0);
    setDemoStart(new Date().toISOString());
  }, []);

  const sendDraft = useCallback(async () => {
    const res = await fetch("/api/designs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ customer_name: demoFacts.customer_name ?? "Caller", source: "voice", home: factsToHome(demoFacts), locks: EMPTY_LOCKS }),
    });
    if (!res.ok) return toast.error("Could not send the draft");
    const row = (await res.json()) as DesignRow;
    setSent(row.id);
    setDemoStep(SCRIPT.length);
    // no toast: it covered "Open in planner", which already says the same thing (the card reads "In the planner's inbox")
  }, [demoFacts]);

  // Real address → real roof and the street (Google), only for addresses the caller gave. d-voice already looks the
  // roof up during the call (facts.solar); otherwise ask /api/solar ourselves.
  const callSolar = mode === "real" ? ((real?.solar as SolarResult | undefined) ?? null) : null;
  const [solarFor, setSolarFor] = useState<{ address: string; result: SolarResult } | null>(null);
  const address = facts.address?.trim() || null;
  const solar = callSolar ?? (solarFor && solarFor.address === address ? solarFor.result : null);
  useEffect(() => {
    if (!address || callSolar) return;
    const ctrl = new AbortController();
    fetch(`/api/solar?address=${encodeURIComponent(address)}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? (r.json() as Promise<SolarResult>) : null))
      .then((r) => r && !ctrl.signal.aborted && setSolarFor({ address, result: r }))
      .catch(() => {});
    return () => ctrl.abort();
  }, [address, callSolar]);
  // a roof result without segments must never take the hero screen down: then only its location is used
  const roof3d = useMemo(() => {
    if (!solar || solar.status !== "ok" || !Array.isArray((solar as { segments?: unknown }).segments)) return undefined;
    try {
      return roofFromSolarResult(solar);
    } catch {
      return undefined;
    }
  }, [solar]);
  const location = useMemo<StageLocation | undefined>(
    () =>
      real?.location ??
      (solar && Number.isFinite(solar.lat) && Number.isFinite(solar.lng) ? { lat: solar.lat as number, lng: solar.lng as number, address: address ?? undefined } : undefined),
    [real?.location, solar, address],
  );

  // after hang-up, the stored create_design draft: the screen and the inbox link show the same numbers
  const shownDraft = mode === "real" && call?.status !== "live" && savedDraft ? savedDraft : (draft ?? savedDraft);
  const home = useMemo(() => engineHome, [factsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const target = useMemo(() => revealFromFacts(facts, shownDraft, mode !== "idle"), [factsKey, shownDraft, mode]); // eslint-disable-line react-hooks/exhaustive-deps
  const reveal = useStagedReveal(target);
  const staged = useMemo(() => stagedDesign(shownDraft, reveal), [shownDraft, reveal]);
  // c-3d's build-up keys; the bare house always stands (idle = waiting for a call, never the still with panels); existing solar is on the roof as soon as the house stands (it comes from the home's facts);
  // the inverter follows the first panels (c-3d default)
  const stageReveal = useMemo<StageReveal>(
    () => ({ shell: true, roof: true, warm: reveal.warm, existingPv: reveal.shell, panels: reveal.panels, battery: reveal.battery, car: reveal.car, heatpump: reveal.heatpump }),
    [reveal],
  );

  // The full transcript arrives after the call; until then show the caller's answers as the agent heard them.
  const stated = mode === "real" ? ((call?.facts as { stated?: Record<string, unknown> } | undefined)?.stated ?? null) : null;
  const heard: TranscriptTurn[] = heardTurns(stated, heardOrder.callId === call?.id ? heardOrder.order : []);
  const transcript: TranscriptTurn[] =
    mode === "demo" ? SCRIPT.slice(0, demoStep).map((t) => ({ role: t.role, text: t.text })) : call?.transcript?.length ? call.transcript : heard;
  const live = mode === "demo" ? !demoDone && !sent : call?.status === "live";
  const clock = useClock(mode === "demo" ? demoStart : (call?.created_at ?? null), !!live);
  const title = facts.customer_name ?? call?.customer_name ?? (mode === "idle" ? "Waiting for a call" : "Incoming call");
  const items = chips(facts);
  const pendingIdx = items.findIndex((i) => !i.done);
  const transcriptBox = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const el = transcriptBox.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: reducedMotion() ? "auto" : "smooth" });
  }, [transcript.length]);
  const inInbox = sent || draftRowId;
  const wide = useWide();

  return (
    <main
      id="main"
      className="mx-auto grid w-full max-w-[1600px] flex-1 grid-cols-[minmax(0,1fr)] gap-4 px-4 py-4 md:px-6 md:py-6 lg:h-[calc(100dvh-57px)] lg:min-h-0 lg:flex-none lg:grid-cols-[minmax(360px,0.82fr)_minmax(0,1.5fr)] lg:grid-rows-[minmax(0,1fr)] lg:gap-6"
    >
      {/* ── Left: the call ─────────────────────────────────────────────────────────────── */}
      <section aria-label="The call" className="contents lg:order-1 lg:flex lg:min-h-0 lg:flex-col lg:gap-4">
        <header className="order-1 flex items-start gap-3 md:gap-4">
          <span className="relative mt-1 grid size-14 shrink-0 place-items-center" aria-hidden>
            {live && <span className="absolute -inset-1 animate-[ping_2s_cubic-bezier(0,0,0.2,1)_infinite] rounded-full border-2 border-ai-orange/50 [--tw-scale:1] motion-reduce:hidden" />}
            <span className={cn("absolute inset-0 rounded-full", live ? "bg-ai" : "bg-border")} />
            <span className="absolute inset-[3px] grid place-items-center rounded-full bg-surface-1">
              <Phone className={cn("size-5", live ? "text-ai-text" : "text-ink-muted")} strokeWidth={1.5} />
            </span>
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              {live ? (
                <StatusBadge tone="ai" pulse>
                  Listening · <span className="font-mono tabular">{clock}</span>
                </StatusBadge>
              ) : mode === "idle" ? (
                <StatusBadge tone="neutral">No call right now</StatusBadge>
              ) : (
                <StatusBadge tone="neutral">Call ended · <span className="font-mono tabular">{clock}</span></StatusBadge>
              )}
              <span className="text-body-sm text-ink-muted">{mode === "demo" ? "Demo call" : "Site visit call"}</span>
            </div>
            <h1 className="m-0 line-clamp-2 text-[clamp(26px,2.4vw,36px)] text-balance leading-[1.1] font-normal tracking-[-0.02em]">{title}</h1>
            {mode === "idle" && <AgentStatusLine />}
          </div>
          <Button variant="secondary" onClick={startDemo} className="mt-1 shrink-0">
            {mode !== "demo" ? <Play data-icon="inline-start" strokeWidth={1.5} /> : <RotateCcw data-icon="inline-start" strokeWidth={1.5} />}
            {mode !== "demo" ? "Play demo call" : "Restart"}
          </Button>
        </header>

        <ul aria-label="What the agent has so far" className="order-3 m-0 flex list-none flex-wrap gap-2 p-0">
          {items.map((it, i) => {
            const asking = live && i === pendingIdx;
            return (
              <li
                key={it.key}
                className={cn(
                  "inline-flex h-8 items-center gap-2 rounded-full border pr-3 pl-1.5 text-[14px] leading-none transition-colors duration-300",
                  it.done ? "border-border bg-surface-1 text-ink" : asking ? "border-ai-orange/60 border-dashed text-ai-text" : "border-dashed border-border-strong/50 text-ink-muted",
                )}
              >
                {it.done ? (
                  <span key="done" className="grid size-5 place-items-center rounded-full bg-success-tint text-success-text animate-in zoom-in-50 duration-300 motion-reduce:animate-none">
                    <Check className="size-3" strokeWidth={2.25} aria-hidden />
                  </span>
                ) : (
                  <span className={cn("size-5 rounded-full border-[1.5px] border-dashed", asking ? "animate-spin border-ai-orange [animation-duration:3s] motion-reduce:animate-none" : "border-border-strong/60")} aria-hidden />
                )}
                <span className="sr-only">{it.done ? "Collected: " : asking ? "Asking now: " : "Not yet: "}</span>
                {it.done ? <span key="t" className="animate-in fade-in duration-300 motion-reduce:animate-none">{it.text}</span> : it.label}
              </li>
            );
          })}
        </ul>

        <div className="relative order-4 flex min-h-[280px] flex-1 flex-col rounded-lg border border-border bg-surface-1 lg:min-h-0">
          {transcript.length === 0 ? (
            <div className="m-auto flex max-w-xs flex-col items-center gap-3 p-6 text-center text-body-sm text-ink-muted">
              {mode === "real" ? "Listening…" : "No conversation yet"}
            </div>
          ) : (
            <ol ref={transcriptBox} className="m-0 flex min-h-0 flex-1 list-none flex-col gap-3 overflow-y-auto overscroll-contain p-4 md:p-5" aria-live="polite">
              {transcript.map((t, i) => {
                const customer = t.role !== "agent";
                return (
                  <li
                    key={i}
                    className={cn(
                      "relative max-w-[88%] rounded-lg px-4 py-2.5 animate-in fade-in slide-in-from-bottom-1 duration-300 motion-reduce:animate-none",
                      customer ? "self-end bg-surface-2 text-ink" : "self-start text-ink-body",
                    )}
                  >
                    <span className="sr-only">{customer ? "Caller: " : "Agent: "}</span>
                    {customer ? (
                      <q className={cn(quoteFont, "font-serif text-[18px] leading-[27px] not-italic before:content-none after:content-none")}>{stripVoiceTags(t.text)}</q>
                    ) : (
                      <span className="text-[15px] leading-[23px]">{stripVoiceTags(t.text)}</span>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </section>

      {/* ── Right: the house builds itself, the draft under it ─────────────────────────── */}
      <section aria-label="The house" className="order-2 flex min-h-0 flex-col gap-3 lg:order-2">
        <HouseStage
          design={staged}
          home={home}
          mode="planner"
          roof={roof3d}
          location={location}
          reveal={stageReveal}
          controls="minimal"
          labels={wide}
          flyIn={false}
          // Full height on lg, sized on the stage itself (any renderer: model, street, inside), not through wrappers:
          // viewport − nav 57 − main padding 48 − gap 12 − draft card 188 − border 2
          className="lg:[&_[data-h3d-stage]]:aspect-auto lg:[&_[data-h3d-stage]]:h-[max(320px,calc(100dvh-307px))]"
        />

        <div
          aria-labelledby="draft-t"
          className={cn(
            "flex shrink-0 flex-col justify-between gap-3 rounded-lg border bg-surface-1 px-4 py-3.5 md:px-5 lg:h-[188px]",
            shownDraft
              ? "border-[1.5px] border-transparent [background:linear-gradient(var(--surface-1),var(--surface-1))_padding-box,linear-gradient(90deg,var(--ai-amber),var(--ai-orange),var(--ai-salmon))_border-box]"
              : "border-border",
          )}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="draft-t" className="m-0 text-[15px] font-semibold">Draft design</h2>
            <div className="flex items-center gap-2">
              <ServedBadge served={shownDraft?.served} />
              {shownDraft && <StatusBadge tone="ai">Drafted by AI</StatusBadge>}
            </div>
          </div>
          {shownDraft ? (
            <dl className="m-0 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
              {COMPONENTS.map((c) => (
                <Metric key={c} c={c} draft={shownDraft} prev={prevDraft} />
              ))}
            </dl>
          ) : (
            <p className="m-0 text-body-sm text-ink-muted">Waiting for the first numbers</p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="m-0 text-[13px] text-ink-muted">{inInbox ? "In the planner's inbox for review." : null}</p>
            <div className="flex gap-2">
              {mode === "demo" && draft && !sent && <Button onClick={sendDraft}>End call and send draft</Button>}
              {inInbox && (
                <Button variant="secondary" render={<Link href={`/?d=${sent ?? draftRowId}`} />} nativeButton={false}>
                  Open in planner
                </Button>
              )}
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
