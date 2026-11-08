"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BatteryMedium, Check, Fan, Lock, Pause, Play, PlugZap, RotateCcw, SunMedium } from "lucide-react";
import { toast } from "sonner";
import { HouseStage } from "@/components/house3d";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/field";
import { ServedBadge } from "@/components/ui/served-badge";
import { choicesFor } from "@/lib/allowed";
import { sizeOf } from "@/lib/diff";
import { fmtEur, fmtInt } from "@/lib/format";
import type { Offer } from "@/lib/offer";
import type { DesignResponse, Home } from "@/lib/types";
import { cn } from "@/lib/utils";
import { listenOnce } from "./listen-once";
import { captionAt, partLine, plainText, timeOfDayAt, variantView, type OfferPart, type TimedSegment } from "./offer-logic";

function household(h: Home) {
  const who = h.inhabitants ? (h.inhabitants === 1 ? "one person" : h.inhabitants === 4 ? "a family of four" : `${h.inhabitants} people`) : "your home";
  const car = h.has_ev ? ", with an electric car" : "";
  return `Designed for ${who} using about ${fmtInt(h.annual_kwh)} kWh a year${car}.`;
}

/** Catalogue PV sizes are multiples of 0.45 kWp: show 11.25, not 11.3. */
const kwp = new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 2 });

const reduced = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Counts from the last shown value to the new one in 300 ms; always lands on the exact value. */
function useCountUp(target: number) {
  const [v, setV] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    const start = from.current;
    from.current = target;
    if (start === target || reduced()) {
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
    const done = setTimeout(() => setV(target), 450);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(done);
    };
  }, [target]);
  return v;
}

function Num({ value, format }: { value: number; format: (n: number) => string }) {
  const v = useCountUp(value);
  return <>{format(v)}</>;
}

const clock = (h: number) => {
  const m = Math.round(h * 60);
  return `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};
const partOfDay = (h: number) => (h < 11 ? "Morning" : h < 15 ? "Midday" : h < 18.5 ? "Afternoon" : "Evening");

/** One decision: what it is on the first line, the choice under it (value on the same line when `inline`). */
function Choice({ id, focused, icon, title, sub, inline, children }: { id?: string; focused?: boolean; icon: React.ReactNode; title: string; sub: string; inline?: boolean; children: React.ReactNode }) {
  return (
    <div
      id={id}
      className={cn(
        "-mx-4 flex scroll-mt-24 gap-3 px-4 py-4 transition-[background-color,box-shadow] duration-300",
        inline ? "items-center justify-between gap-4" : "flex-col",
        // the part the homeowner clicked on the house
        focused && "bg-ai-tint shadow-[inset_3px_0_0_var(--ai-orange)]",
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-full bg-surface-2" aria-hidden>
          {icon}
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="text-[16px] font-semibold">{title}</span>
          <span className="text-[14px] leading-5 text-ink-muted">{sub}</span>
        </span>
      </div>
      <div className="min-w-0 shrink-0">{children}</div>
    </div>
  );
}

/** A part the installer set: its size, and that it is not one of the homeowner's choices. */
function Fixed({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex flex-col items-end gap-0.5 text-right">
      <span className="font-mono text-[22px] font-medium tabular">{children}</span>
      <span className="inline-flex items-center gap-1 text-[12px] text-ink-muted">
        <Lock className="size-3" strokeWidth={2} aria-hidden />
        Set by your installer
      </span>
    </span>
  );
}

export function OfferView({ offer }: { offer: Offer }) {
  const base = offer.design;
  const [design, setDesign] = useState<DesignResponse>(base);
  const [busy, setBusy] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const reqId = useRef(0);
  const batteryAllowed = (offer.allowed.find((a) => a.component === "battery")?.values ?? []) as number[];
  const wallboxAllowed = offer.allowed.find((a) => a.component === "wallbox")?.values ?? [];
  // Only what the installer allowed when sending (the server rejects anything else).
  const pvAllowed = choicesFor(offer.allowed, "pv") as number[];
  const hpAllowed = choicesFor(offer.allowed, "heatpump").length > 1;
  const recommendedPv = sizeOf(base.design, "pv") ?? 0;
  const [pv, setPv] = useState<number>(recommendedPv);
  const [battery, setBattery] = useState<number>(sizeOf(base.design, "battery") ?? 0);
  const [wallbox, setWallbox] = useState<boolean>(base.design.wallbox.include);
  const [heatpump, setHeatpump] = useState(false);

  async function choose(next: { pv_kwp?: number; battery_kwh: number; wallbox: boolean }) {
    const id = ++reqId.current; // only the latest choice may update the page
    setBusy(true);
    try {
      const res = await fetch(`/api/offer/${offer.token}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "variant", ...(pvAllowed.length ? { pv_kwp: pv } : {}), ...next }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? "Please try again.");
      const d = (await res.json()) as DesignResponse;
      if (id === reqId.current) setDesign(d);
    } catch (e) {
      toast.error("Could not update your offer", { description: (e as Error).message });
    } finally {
      if (id === reqId.current) setBusy(false);
    }
  }

  // The heat pump variant is the engine's own "with heat pump" numbers (options.heatpump); sizes never change here.
  const hpOption = design.options?.heatpump;
  const hpOffered = !!hpOption?.available && !design.design.heatpump.include;
  const view = useMemo(() => variantView(design, heatpump && hpOffered), [design, heatpump, hpOffered]);
  const baseView = useMemo(() => variantView(base, false), [base]);
  const n = view.numbers;
  const panels = n.pv ? Math.round(n.pv / 0.45) : 0;
  const recommendedBattery = sizeOf(base.design, "battery") ?? 0;
  // sizes for the focus line come from the shown (engine) design; choices only from what the installer allowed
  const partSize = (p: OfferPart) => sizeOf(view.design.design, p);
  const partChoices = (p: OfferPart): (number | boolean)[] =>
    p === "pv" ? pvAllowed : p === "battery" ? batteryAllowed : p === "wallbox" ? (wallboxAllowed as boolean[]) : hpAllowed && hpOffered ? [false, true] : [];
  const changed = pv !== recommendedPv || battery !== recommendedBattery || wallbox !== base.design.wallbox.include || (heatpump && hpOffered);

  // The house's clock: the viewer's slider, or the voice while "Listen" plays.
  const [hour, setHour] = useState(12.5);
  // Click a part on the house: the camera zooms to it, its row lights up, and a plain line says what it is
  const [part, setPart] = useState<OfferPart | null>(null);
  const onSelectPart = useCallback((k: string | null) => {
    const p = k === "inverter" ? "pv" : (k as OfferPart | null);
    setPart(p);
    if (p) document.getElementById(`choice-${p}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, []);
  const [caption, setCaption] = useState<string | null>(null);
  const [stopSignal, setStopSignal] = useState(0);
  const onUserHour = useCallback((h: number) => {
    setStopSignal((n) => n + 1); // the viewer takes over the clock: Listen pauses
    setHour(h);
  }, []);

  return (
    <main id="main" className="mx-auto flex w-full max-w-6xl min-w-0 flex-1 flex-col gap-6 overflow-x-clip px-4 pt-6 pb-12 md:px-8 md:pt-10">
      <header className="flex min-w-0 flex-col gap-2 md:max-w-2xl">
        <p className="m-0 text-body-sm text-ink-muted">{offer.customer ? `Offer for ${offer.customer.split(",")[0]}` : "Your offer"} · from your installer</p>
        <h1 className="m-0 text-[clamp(30px,6vw,44px)] leading-[1.05] font-normal tracking-[-0.02em] text-balance">Your energy system, explained</h1>
        <p className="m-0 text-body text-ink-body">{household(offer.home)}</p>
        <ServedBadge served={design.served} className="self-start" />
      </header>

      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-6 md:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] md:items-start md:gap-8">
        {/* The house: full-bleed on phones, framed and sticky on larger screens. Nothing over the model (controls="time"). */}
        <section aria-label="Your house through a sunny day" className="-mx-4 flex min-w-0 flex-col gap-3 md:sticky md:top-20 md:mx-0">
          <HouseStage
            design={view.design}
            home={offer.home}
            mode="homeowner"
            timeOfDay={hour}
            onTimeOfDayChange={onUserHour}
            onSelect={onSelectPart}
            focus={part}
            controls="time"
            className="rounded-none border-x-0 md:rounded-lg md:border-x"
          />
          <p className={cn("m-0 min-h-[3lh] px-4 text-[17px] leading-[26px] text-balance md:px-1", caption || part ? "text-ink" : "hidden")} aria-live="polite">
            {caption ? (
              <span key={caption} className="animate-in fade-in duration-300 motion-reduce:animate-none">
                <span className="mr-2 font-mono text-[13px] text-ai-text tabular">{partOfDay(hour)} · {clock(hour)}</span>
                {caption}
              </span>
            ) : part ? (
              <span key={part} className="animate-in fade-in duration-300 motion-reduce:animate-none">
                {partLine(part, partSize(part), partChoices(part))}
              </span>
            ) : null}
          </p>
        </section>

        <div className="flex min-w-0 flex-col gap-6">
          <ListenButton
            offer={offer}
            onHour={setHour}
            onCaption={setCaption}
            stopSignal={stopSignal}
            onStart={() => {
              // the voice explains the installer's suggestion: show exactly that while it plays
              if (!changed) return;
              reqId.current++;
              setBusy(false);
              setHeatpump(false);
              setPv(recommendedPv);
              setBattery(recommendedBattery);
              setWallbox(base.design.wallbox.include);
              setDesign(base);
              toast("Back to your installer's suggestion", { description: "The voice explains that one. Your choices are one tap away." });
            }}
          />

          <fieldset
            disabled={busy}
            aria-label="Your system"
            className={cn("m-0 flex min-w-0 flex-col divide-y divide-border rounded-lg border border-border bg-surface-1 px-4 py-0", busy && "opacity-70 transition-opacity")}
          >
            <Choice
              id="choice-pv"
              focused={part === "pv"}
              icon={<SunMedium className="size-5 text-comp-pv" strokeWidth={1.5} />}
              title="Solar panels"
              inline={pvAllowed.length === 0}
              sub={n.pv ? `${panels} panels on your roof${pvAllowed.length > 1 ? " · sized by your installer" : ""}` : "No new panels: you already have solar"}
            >
              {pvAllowed.length > 0 && (
                <Segmented
                  label="Solar size"
                  value={pv}
                  onChange={(v) => {
                    setPv(v);
                    choose({ pv_kwp: v, battery_kwh: battery, wallbox });
                  }}
                  options={pvAllowed.map((v) => ({ value: v, label: `${kwp.format(v)} kWp${v === recommendedPv ? " ★" : ""}` }))}
                />
              )}
              {pvAllowed.length === 0 &&
                (n.pv ? (
                  <Fixed>
                    <Num value={n.pv} format={(x) => kwp.format(x)} /> <span className="text-[14px] text-ink-muted">kWp</span>
                  </Fixed>
                ) : (
                  <span className="font-mono text-[22px] font-medium tabular">–</span>
                ))}
            </Choice>
            {batteryAllowed.length <= 1 && recommendedBattery > 0 && (
              <Choice id="choice-battery" focused={part === "battery"} inline icon={<BatteryMedium className="size-5 text-comp-battery" strokeWidth={1.5} />} title="Battery" sub="Stores midday sun for the evening">
                <Fixed>
                  {recommendedBattery} <span className="text-[14px] text-ink-muted">kWh</span>
                </Fixed>
              </Choice>
            )}
            {batteryAllowed.length > 1 && (
              <Choice id="choice-battery" focused={part === "battery"} icon={<BatteryMedium className="size-5 text-comp-battery" strokeWidth={1.5} />} title="Battery" sub="Stores midday sun for the evening">
                <Segmented
                  label="Battery size"
                  value={battery}
                  onChange={(v) => {
                    setBattery(v);
                    choose({ battery_kwh: v, wallbox });
                  }}
                  options={batteryAllowed.map((v) => ({ value: v, label: v === 0 ? "None" : `${v} kWh${v === recommendedBattery ? " ★" : ""}` }))}
                />
              </Choice>
            )}
            {hpOffered && hpAllowed && hpOption?.available && (
              <Choice
                id="choice-heatpump"
                focused={part === "heatpump"}
                icon={<Fan className="size-5 text-comp-heatpump" strokeWidth={1.5} />}
                title="Heat pump"
                sub={heatpump ? `Replaces your ${offer.home.heating?.toLowerCase() ?? "old"} heating · saves about ${fmtEur(n.heatingSavings)} a year on heating` : "An option your installer offers"}
              >
                <Segmented
                  label="Heat pump"
                  value={heatpump ? "with" : "without"}
                  onChange={(v) => setHeatpump(v === "with")}
                  options={[
                    { value: "without", label: "Not now" },
                    { value: "with", label: `With heat pump · ${hpOption.kw} kW` },
                  ]}
                />
              </Choice>
            )}
            {wallboxAllowed.length <= 1 && base.design.wallbox.include && (
              <Choice id="choice-wallbox" focused={part === "wallbox"} inline icon={<PlugZap className="size-5 text-comp-wallbox" strokeWidth={1.5} />} title="Car charger" sub={offer.home.has_ev ? "Charges your car from your own solar" : "Ready for an electric car later"}>
                <Fixed>
                  {base.design.wallbox.kw ? (
                    <>
                      {base.design.wallbox.kw} <span className="text-[14px] text-ink-muted">kW</span>
                    </>
                  ) : (
                    "Included"
                  )}
                </Fixed>
              </Choice>
            )}
            {wallboxAllowed.length > 1 && (
              <Choice id="choice-wallbox" focused={part === "wallbox"} icon={<PlugZap className="size-5 text-comp-wallbox" strokeWidth={1.5} />} title="Car charger" sub={offer.home.has_ev ? "Charges your car from your own solar" : "Ready for an electric car later"}>
                <Segmented
                  label="Car charger"
                  value={wallbox ? "yes" : "no"}
                  onChange={(v) => {
                    const on = v === "yes";
                    setWallbox(on);
                    choose({ battery_kwh: battery, wallbox: on });
                  }}
                  options={[
                    { value: "no", label: "Without" },
                    { value: "yes", label: `Included${base.design.wallbox.include ? " ★" : ""}` },
                  ]}
                />
              </Choice>
            )}
          </fieldset>
          {(pvAllowed.length > 1 || batteryAllowed.length > 1 || wallboxAllowed.length > 1) && <p className="-mt-4 m-0 text-[13px] text-ink-muted">★ what your installer recommends</p>}

          <section aria-label="What it means for you" className="grid grid-cols-2 gap-3">
            {(
              [
                ["Solar power per year", n.yieldKwh ? <>≈ <Num value={n.yieldKwh} format={fmtInt} /> <span className="text-[14px] text-ink-muted">kWh</span></> : "–"],
                ["Power you make yourself", <><Num value={Math.round(n.autarky * 100)} format={(x) => fmtInt(x)} /> <span className="text-[14px] text-ink-muted">%</span></>],
                ["Savings per year", n.savings != null ? <Num value={n.savings} format={fmtEur} /> : "–"],
                ["Pays for itself in", n.payback != null ? <><Num value={n.payback} format={(x) => x.toFixed(1)} /> <span className="text-[14px] text-ink-muted">years</span></> : "–"],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="flex min-w-0 flex-col gap-1 rounded-lg border border-border bg-surface-1 p-4">
                <span className="text-[13px] text-ink-muted">{label}</span>
                <span className="font-mono text-[20px] leading-7 font-medium tabular sm:text-[22px]">{value}</span>
              </div>
            ))}
          </section>

          <div className="-mt-2 flex flex-col gap-2" aria-live="polite">
            {changed && n.capex != null && baseView.numbers.capex != null && (
              <p className="m-0 text-body-sm text-ink-body">
                Compared with your installer&apos;s suggestion, this {n.capex >= baseView.numbers.capex ? "adds" : "saves"} about{" "}
                <b className="font-mono tabular">{fmtEur(Math.abs(n.capex - baseView.numbers.capex))}</b> and {n.autarky >= baseView.numbers.autarky ? "raises" : "lowers"} the power you make yourself by{" "}
                <b className="font-mono tabular">{Math.abs(Math.round((n.autarky - baseView.numbers.autarky) * 100))}</b> points
                {heatpump && hpOffered && n.heatingSavings > 0 ? <>, with about <b className="font-mono tabular">{fmtEur(n.heatingSavings)}</b> a year saved on heating included in the savings</> : null}.
              </p>
            )}
            <p className="m-0 text-[12px] leading-4 text-ink-muted">Prices and savings are estimates. Your installer confirms the final price.</p>
          </div>

          <div className="flex flex-col gap-3 border-t border-border pt-6">
            <p className="m-0 text-[15px] text-ink-body">Questions about your system, or want a different size? Your installer knows your roof.</p>
            <div className="flex flex-wrap gap-3">
              <Button size="lg" onClick={() => toast("Your installer will call you back", { description: "We have passed on your question." })}>
                Ask your installer
              </Button>
              <Button
                variant="secondary"
                size="lg"
                disabled={accepted || busy}
                onClick={async () => {
                  const res = await fetch(`/api/offer/${offer.token}`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ action: "accept", ...(pvAllowed.length ? { pv_kwp: pv } : {}), battery_kwh: battery, wallbox, ...(heatpump && hpOffered ? { heatpump: true } : {}) }),
                  });
                  if (!res.ok) return toast.error("Could not send your answer. Please try again.");
                  setAccepted(true);
                  toast.success("Thank you! Your installer will be in touch to book the visit.", {
                    description: heatpump && hpOffered ? "They will go through the heat pump option with you." : undefined,
                  });
                }}
              >
                {accepted ? (
                  <>
                    <Check data-icon="inline-start" strokeWidth={2} /> Accepted
                  </>
                ) : (
                  "Accept this offer"
                )}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}

interface ListenReply {
  text: string;
  segments?: TimedSegment[];
  duration_s?: number;
  audio_base64: string | null;
  audio_url?: string;
}

/**
 * "Listen to your offer": d-voice's explanation with timed sentences. While it plays, the house's clock follows the
 * voice (morning → noon → evening) and the current sentence shows under the house. Without audio the same timeline
 * runs on a timer (read along); without segments the house walks morning → evening over the clip.
 */
function ListenButton({ offer, onHour, onCaption, stopSignal, onStart }: {
  offer: Offer;
  /** Playback starts from the beginning (the page shows the installer's suggestion again). */
  onStart: () => void;
  onHour: (h: number) => void;
  onCaption: (s: string | null) => void;
  /** Changes when the viewer drags the time themselves: pause. */
  stopSignal: number;
}) {
  const [state, setState] = useState<"idle" | "loading" | "playing" | "paused" | "done">("idle");
  const [reply, setReply] = useState<ListenReply | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const raf = useRef(0);
  const clockT = useRef({ t: 0, last: 0 }); // timer playback when there is no audio

  const duration = (r: ListenReply) => r.duration_s || (r.segments?.at(-1)?.end_s ?? 0) || Math.max(20, r.text.length * 0.065);
  const now = () => (audio.current ? audio.current.currentTime : clockT.current.t);

  const frame = useCallback(
    (r: ListenReply) => {
      const loop = (ts: number) => {
        if (!audio.current) {
          clockT.current.t += clockT.current.last ? (ts - clockT.current.last) / 1000 : 0;
          clockT.current.last = ts;
        }
        const t = now();
        const segs = r.segments ?? [];
        onHour(timeOfDayAt(t, segs, duration(r)));
        const seg = captionAt(t, segs);
        onCaption(seg ? plainText(seg.text) : segs.length ? null : plainText(r.text));
        if (t >= duration(r) && (!audio.current || audio.current.ended)) {
          setState("done");
          return;
        }
        raf.current = requestAnimationFrame(loop);
      };
      cancelAnimationFrame(raf.current);
      clockT.current.last = 0;
      raf.current = requestAnimationFrame(loop);
    },
    [onHour, onCaption],
  );

  const pause = useCallback(() => {
    cancelAnimationFrame(raf.current);
    audio.current?.pause();
    setState((s) => (s === "playing" ? "paused" : s));
  }, []);
  const [seenStop, setSeenStop] = useState(stopSignal);
  if (seenStop !== stopSignal) {
    // adjust state while rendering (no effect): the viewer moved the time
    setSeenStop(stopSignal);
    if (state === "playing") setState("paused");
  }
  useEffect(() => {
    if (state !== "playing") {
      cancelAnimationFrame(raf.current);
      audio.current?.pause();
    }
  }, [state]);
  useEffect(() => {
    return () => {
      cancelAnimationFrame(raf.current);
      audio.current?.pause();
    };
  }, []);

  // Start the paid work (script + voice) when the page opens, not on the click: by the time the viewer reaches the
  // button the clip is ready, and play() runs inside the click (Safari). One request per offer per page load.
  const loadListen = useCallback(
    () =>
      listenOnce<ListenReply>(offer.token, async () => {
        const res = await fetch(`/api/offer/${offer.token}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "listen" }),
        });
        return res.ok ? ((await res.json()) as ListenReply) : null;
      }),
    [offer.token],
  );
  useEffect(() => {
    void loadListen();
  }, [loadListen]);

  async function start(r: ListenReply, from = 0) {
    if (from === 0) onStart();
    clockT.current = { t: from, last: 0 };
    if (r.audio_url || r.audio_base64) {
      if (!audio.current) {
        // the inline clip first (no second request; /voice/*.mp3 may sit behind the planner gate on older deploys)
        const a = new Audio(r.audio_base64 ? `data:audio/mpeg;base64,${r.audio_base64}` : r.audio_url!);
        audio.current = a;
      }
      audio.current.currentTime = from;
      try {
        await audio.current.play();
      } catch {
        audio.current = null; // autoplay blocked or bad clip: read along instead
      }
    }
    setState("playing");
    frame(r);
  }

  async function onClick() {
    if (state === "playing") return pause();
    if (state === "paused" && reply) return start(reply, now());
    if (state === "done" && reply) return start(reply, 0);
    setState("loading");
    try {
      const r = await loadListen(); // the request the page started on open (or one retry if that failed)
      if (!r) throw new Error();
      setReply(r);
      await start(r);
    } catch {
      // Fallback: the engine's plain-language explanation as text; the house still walks through the day.
      try {
        const res = await fetch(`/api/offer/${offer.token}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "explain" }),
        });
        if (!res.ok) throw new Error();
        const r: ListenReply = { text: plainText(await res.text()), audio_base64: null };
        setReply(r);
        await start(r);
      } catch {
        setState("idle");
        toast.error("The explanation is not available right now.");
      }
    }
  }

  const label =
    state === "loading" ? "Preparing your offer…" : state === "playing" ? "Pause" : state === "paused" ? "Continue listening" : state === "done" ? "Listen again" : "Listen to your offer";
  const Icon = state === "playing" ? Pause : state === "done" ? RotateCcw : Play;
  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        onClick={onClick}
        disabled={state === "loading"}
        aria-pressed={state === "playing"}
        className="flex cursor-pointer items-center gap-4 rounded-pill bg-surface-1 py-3 pr-6 pl-3 text-left text-ink ring-1 ring-border transition-[transform,box-shadow] duration-150 active:scale-[0.98] disabled:opacity-80 motion-reduce:active:scale-100 [@media(hover:hover)]:hover:ring-border-strong"
      >
        <span className="relative grid size-11 shrink-0 place-items-center rounded-full bg-ai" aria-hidden>
          {state === "playing" && <span className="absolute -inset-1 animate-[ping_2s_cubic-bezier(0,0,0.2,1)_infinite] rounded-full border-2 border-ai-orange/40 motion-reduce:hidden" />}
          <Icon className={cn("size-4 text-[#1b1d20]", Icon === Play && "translate-x-px")} fill={Icon === RotateCcw ? "none" : "currentColor"} strokeWidth={Icon === RotateCcw ? 2 : 1.5} />
        </span>
        <span className="flex flex-col">
          <span className="text-[16px] font-semibold">{label}</span>
          <span className="text-[13px] text-ink-muted">{state === "idle" || state === "loading" ? "About 45 seconds" : "The house follows the voice through one sunny day"}</span>
        </span>
      </button>
      {reply && state !== "idle" && (
        <details className="group rounded-lg bg-ai-tint px-4 py-3 text-[15px] leading-6 text-ink">
          <summary className="cursor-pointer text-[13px] font-medium text-ai-text">Read the whole explanation</summary>
          <p className="m-0 mt-2">{plainText(reply.text)}</p>
        </details>
      )}
    </div>
  );
}
