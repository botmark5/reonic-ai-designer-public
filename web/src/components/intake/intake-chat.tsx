"use client";

import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Check, CornerDownLeft, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ServedBadge } from "@/components/ui/served-badge";
import { StatusBadge } from "@/components/ui/status-badge";
import { HouseStage, roofFromSolarResult, type StageLocation, type StageReveal } from "@/components/house3d";
import { factsToHome, type Facts } from "@/app/live/facts";
import { revealFromFacts, stagedDesign, stepToward, type LiveReveal } from "@/app/live/stage";
import { COMPONENTS, sizeOf } from "@/lib/diff";
import { LABEL, UNIT } from "@/lib/format";
import type { IntakeReply } from "@/lib/intake";
import type { DesignRow } from "@/lib/supabase";
import type { ComponentKey, DesignResponse } from "@/lib/types";
import { cn } from "@/lib/utils";
import { applyAnswer, canDraft, nextQuestion, progress, QUESTIONS, type Answers, type Question } from "./questions";

interface Turn {
  /** the question this turn belongs to (for Back) */
  q: string;
  role: "agent" | "you";
  text: string;
}
interface Step {
  q: string;
  answers: Answers;
}

const DOT: Record<ComponentKey, string> = { pv: "bg-comp-pv", battery: "bg-comp-battery", wallbox: "bg-comp-wallbox", heatpump: "bg-comp-heatpump" };
const STEP_MS: Partial<Record<keyof LiveReveal, number>> = { shell: 400, warm: 600, panels: 1200, battery: 800, car: 800 };
const kwp = new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 2 });
const short = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

function reducedMotion() {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/** One build step at a time, like /live (removals at once). */
function useStagedReveal(target: LiveReveal): LiveReveal {
  const [shown, setShown] = useState<LiveReveal>(target);
  const instant = reducedMotion();
  useEffect(() => {
    if (instant) return;
    const next = stepToward(shown, target);
    if (next === shown) return;
    const added = (Object.keys(next) as (keyof LiveReveal)[]).find((k) => next[k] && !shown[k]);
    const t = setTimeout(() => setShown(next), added ? (STEP_MS[added] ?? 600) : 0);
    return () => clearTimeout(t);
  }, [shown, target, instant]);
  return instant ? target : shown;
}

const EMPTY_HOME = factsToHome({});

/** The previous value while the new one is deep-equal (JSON), so memo'd consumers skip equal updates. */
function useStable<T>(value: T): T {
  const key = JSON.stringify(value);
  return useMemo(() => value, [key]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** The 3D house, memoised: it re-renders only when one of its inputs really changes. */
const Stage = memo(function Stage(props: React.ComponentProps<typeof HouseStage>) {
  return <HouseStage {...props} />;
});

function firstTurn(): Turn[] {
  const q = QUESTIONS[0];
  return [{ q: q.id, role: "agent", text: q.ask({}) }];
}

export function IntakeChat() {
  const [answers, setAnswers] = useState<Answers>({});
  const [steps, setSteps] = useState<Step[]>([]); // answered questions in order, with the answers before each
  const [turns, setTurns] = useState<Turn[]>(firstTurn);
  const [other, setOther] = useState("");
  const [otherError, setOtherError] = useState(false);
  // the server's answer for one set of answers (key = the answers it was for); kept while the next one loads
  const [preview, setPreview] = useState<{ key: string; reply: IntakeReply | null } | null>(null);
  const [saved, setSaved] = useState<{ id: string; key: string } | null>(null);
  const [saveFailed, setSaveFailed] = useState<string | null>(null);
  const savingKey = useRef<string | null>(null);
  const answered = useMemo(() => steps.map((s) => s.q), [steps]);
  const current = nextQuestion(answered, answers);
  const { done, total } = progress(answered, answers);
  const finished = current == null;

  // Answers → the voice agent's mapping → engine draft (server). Latest answers win.
  const answersKey = JSON.stringify(answers);
  const wantPreview = !!answers.address || canDraft(answers);
  useEffect(() => {
    if (!wantPreview) return;
    const ctrl = new AbortController();
    const key = answersKey;
    fetch("/api/intake", { method: "POST", headers: { "content-type": "application/json" }, body: `{"answers":${key}}`, signal: ctrl.signal })
      .then((r) => (r.ok ? (r.json() as Promise<IntakeReply>) : null))
      .then((reply) => !ctrl.signal.aborted && setPreview({ key, reply }))
      .catch(() => !ctrl.signal.aborted && setPreview({ key, reply: null }));
    return () => ctrl.abort();
  }, [answersKey, wantPreview]);
  const reply = wantPreview ? (preview?.reply ?? null) : null;
  const loading = wantPreview && preview?.key !== answersKey;

  // Every answer brings a fresh reply (new objects, often equal values). Keep equal values identical so the 3D
  // house only rebuilds what really changed (the Google roof is the same for every answer after the address).
  const design = useStable<DesignResponse | null>(reply?.design ?? null);
  const facts: Facts = useMemo(
    () => ({ ...(reply?.facts ?? {}), annual_kwh_estimate: canDraft(answers) ? (reply?.home.annual_kwh ?? null) : null }) as Facts,
    [reply, answers],
  );
  const target = useMemo(() => revealFromFacts(facts, design, true), [facts, design]);
  const reveal = useStagedReveal(target);
  const staged = useMemo(() => stagedDesign(design, reveal), [design, reveal]);
  const stageReveal = useMemo<StageReveal>(
    () => ({ shell: true, roof: true, warm: reveal.warm, existingPv: true, panels: reveal.panels, battery: reveal.battery, car: reveal.car, heatpump: reveal.heatpump }),
    [reveal],
  );
  const home = useStable(reply?.home ?? EMPTY_HOME);
  const solar = useStable(reply?.solar ?? null);
  const roof3d = useMemo(() => {
    if (!solar || solar.status !== "ok" || !Array.isArray(solar.segments)) return undefined;
    try {
      return roofFromSolarResult(solar);
    } catch {
      return undefined;
    }
  }, [solar]);
  const location = useMemo<StageLocation | undefined>(
    () => (solar && solar.status === "ok" ? { lat: solar.lat, lng: solar.lng, address: reply?.facts.address ?? undefined } : undefined),
    [solar, reply?.facts.address],
  );

  const answer = useCallback(
    (q: Question, set: Answers, said: string) => {
      const next = applyAnswer(answers, set);
      const nextAnswered = [...answered, q.id];
      const after = nextQuestion(nextAnswered, next);
      setSteps((s) => [...s, { q: q.id, answers }]);
      setAnswers(next);
      setOther("");
      setOtherError(false);
      setTurns((t) => [
        ...t,
        { q: q.id, role: "you", text: said },
        ...(after ? [{ q: after.id, role: "agent" as const, text: after.ask(next) }] : []),
      ]);
    },
    [answers, answered],
  );

  const back = useCallback(() => {
    const last = steps[steps.length - 1];
    if (!last) return;
    setSteps((s) => s.slice(0, -1));
    setAnswers(last.answers);
    setSaved(null);
    // drop the answer and everything after it; the question is asked again
    setTurns((t) => {
      const i = t.findIndex((x) => x.q === last.q && x.role === "you");
      return i < 0 ? t : t.slice(0, i);
    });
  }, [steps]);

  const restart = useCallback(() => {
    setAnswers({});
    setSteps([]);
    setTurns(firstTurn());
    setPreview(null);
    setSaved(null);
    setOther("");
  }, []);

  function submitOther() {
    if (!current?.other) return;
    const set = current.other.read(other);
    if (!set) return setOtherError(true);
    answer(current, set, other.trim());
  }

  // Number keys pick a chip (not while typing in the field); Escape steps back.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (!current) return;
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= current.choices.length) {
        e.preventDefault();
        const c = current.choices[n - 1];
        answer(current, c.set, c.label);
      } else if (e.key === "0") {
        e.preventDefault();
        answer(current, {}, current.skip);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, answer]);

  // Done: save the draft once for these answers (the same engine home), so "Open in planner" works.
  const fresh = !loading && !!reply?.design;
  useEffect(() => {
    if (!finished || !fresh || !reply || savingKey.current === answersKey || saveFailed === answersKey) return;
    const key = answersKey;
    savingKey.current = key;
    // source "form": the planner labels it "from a site visit", not "from a call". Databases without the
    // 20261108_designs_source_form migration reject it; then save as "voice" (same fallback idea as /visit).
    const save = (source: "form" | "voice") =>
      fetch("/api/designs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ customer_name: reply.facts.customer_name ?? "New home", address: reply.facts.address, source, home: reply.home }),
      });
    save("form")
      .then((r) => (r.ok ? r : save("voice")))
      .then(async (r) => {
        if (!r.ok) throw new Error();
        const row = (await r.json()) as DesignRow;
        setSaved({ id: row.id, key });
      })
      .catch(() => {
        savingKey.current = null;
        setSaveFailed(key);
        toast.error("Could not save the draft.");
      });
  }, [finished, fresh, reply, answersKey, saveFailed]);
  const saving = finished && fresh && saved?.key !== answersKey && saveFailed !== answersKey;

  const log = useRef<HTMLOListElement>(null);
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight, behavior: reducedMotion() ? "auto" : "smooth" });
  }, [turns.length, finished, saved]);
  const input = useRef<HTMLInputElement>(null);
  // Text-only questions (name) get the field focused; chip questions free the keyboard for the number keys
  // (the field keeps focus after Enter otherwise, and the shortcuts ignore keys typed into a field).
  useEffect(() => {
    if (!current) return;
    if (!current.choices.length) input.current?.focus();
    else if (document.activeElement === input.current) input.current?.blur();
  }, [current]);

  const savedId = saved?.key === answersKey ? saved.id : null;
  // The chat paints first; the house follows in a deferred render (rebuilding it can take seconds on slow GPUs).
  const stageNow = useMemo(
    () => ({
      design: staged, home, mode: "planner" as const, roof: roof3d, location, reveal: stageReveal, controls: "minimal" as const, flyIn: false,
      className: "lg:[&_[data-h3d-stage]]:aspect-auto lg:[&_[data-h3d-stage]]:h-[max(320px,calc(100dvh-307px))]",
    }),
    [staged, home, roof3d, location, stageReveal],
  );
  const stage = useDeferredValue(stageNow);


  return (
    <main
      id="main"
      className="mx-auto grid w-full max-w-[1600px] flex-1 grid-cols-[minmax(0,1fr)] gap-4 px-4 py-4 md:px-6 md:py-6 lg:h-[calc(100dvh-57px)] lg:min-h-0 lg:flex-none lg:grid-cols-[minmax(360px,0.82fr)_minmax(0,1.5fr)] lg:grid-rows-[minmax(0,1fr)] lg:gap-6"
    >
      {/* ── Left: the questions ─────────────────────────────────────────────────────── */}
      <section aria-label="Questions" className="contents lg:order-1 lg:flex lg:min-h-0 lg:flex-col lg:gap-3">
        <header className="order-1 flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <StatusBadge tone="ai">Design assistant</StatusBadge>
            <div className="flex shrink-0 gap-1.5">
              <Button variant="secondary" size="sm" onClick={back} disabled={!steps.length} aria-label="Back one question">
                <ArrowLeft data-icon="inline-start" strokeWidth={1.5} /> Back
              </Button>
              <Button variant="secondary" size="sm" onClick={restart} disabled={!steps.length} aria-label="Start over">
                <RotateCcw data-icon="inline-start" strokeWidth={1.5} /> Start over
              </Button>
            </div>
          </div>
          <h1 className="m-0 line-clamp-2 text-[clamp(26px,2.4vw,36px)] leading-[1.1] font-normal tracking-[-0.02em]">
            {reply?.facts.customer_name ?? "Start with questions"}
          </h1>
          <p className="m-0 text-body-sm text-ink-muted">The voice agent&apos;s questions, typed. The engine sizes every part.</p>
        </header>

        <div className="order-2 flex items-center gap-3" aria-label={`Question ${Math.min(done + 1, total)} of ${total}`}>
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
            <div className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out" style={{ width: `${(done / Math.max(total, 1)) * 100}%` }} />
          </div>
          <span className="font-mono text-[12px] text-ink-muted tabular">
            {done}/{total}
          </span>
        </div>

        <div className="order-4 flex flex-col rounded-lg border border-border bg-surface-1 lg:min-h-0 lg:flex-1">
          <ol ref={log} className="m-0 flex max-h-[42dvh] min-h-[160px] list-none flex-col gap-3 overflow-y-auto overscroll-contain p-4 md:p-5 lg:max-h-none lg:min-h-0 lg:flex-1" aria-live="polite">
            {turns.map((t, i) => (
              <li
                key={i}
                className={cn(
                  "max-w-[88%] rounded-lg px-4 py-2.5 text-[15px] leading-[23px] animate-in fade-in slide-in-from-bottom-1 duration-300 motion-reduce:animate-none",
                  t.role === "you" ? "self-end bg-surface-2 text-ink" : "self-start text-ink-body",
                )}
              >
                <span className="sr-only">{t.role === "you" ? "You: " : "Assistant: "}</span>
                {t.text}
              </li>
            ))}
            {finished && (
              <li className="self-start max-w-[92%] rounded-lg px-4 py-2.5 text-[15px] leading-[23px] text-ink-body animate-in fade-in duration-300 motion-reduce:animate-none">
                {design
                  ? "That's everything. Here is the draft; every size comes from the engine. A planner reviews it before it goes out."
                  : loading
                    ? "That's everything. Drafting the design…"
                    : reply?.ready
                      ? "That's everything. The engine is not answering right now, so the planner will draft this one."
                      : "That's everything. Without a bill, a yearly use or a household size there's nothing to size yet. Go back and add one."}
                {!!reply?.assumptions.length && (
                  <ul className="mt-2 mb-0 list-disc pl-5 text-[13px] leading-5 text-ink-muted">
                    {reply.assumptions.map((a) => (
                      <li key={a}>{a}</li>
                    ))}
                  </ul>
                )}
                {savedId && (
                  // on a phone the draft card is below the chat: the next step sits where the eye already is
                  <Button className="mt-3 lg:hidden" render={<Link href={`/?d=${savedId}`} />} nativeButton={false}>
                    <Check data-icon="inline-start" strokeWidth={2} /> Open in planner
                  </Button>
                )}
              </li>
            )}
          </ol>

          {current && (
            <div className="flex flex-col gap-3 border-t border-border p-4 md:p-5">
              {current.choices.length > 0 && (
                <div role="group" aria-label="Answers" className="flex flex-wrap gap-2">
                  {current.choices.map((c, i) => (
                    <button
                      key={c.label}
                      type="button"
                      onClick={() => answer(current, c.set, c.label)}
                      className="inline-flex h-11 cursor-pointer items-center gap-2 rounded-pill border border-border bg-surface-1 px-4 text-[15px] font-medium text-ink transition-[background-color,border-color,transform] md:h-9 md:px-3.5 md:text-[14px] duration-150 ease-out hover:border-border-strong hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus active:scale-[0.97] motion-reduce:active:scale-100"
                    >
                      {i < 9 && !/^\d/.test(c.label) && <kbd aria-hidden className="hidden font-mono text-[11px] text-ink-muted md:inline">{i + 1}</kbd>}
                      {c.label}
                    </button>
                  ))}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2">
                {current.other && (
                  <form
                    className="flex min-w-[220px] flex-1 items-center gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      submitOther();
                    }}
                  >
                    <label className="sr-only" htmlFor="intake-other">
                      {current.other.label}
                    </label>
                    <input
                      id="intake-other"
                      ref={input}
                      value={other}
                      onChange={(e) => {
                        setOther(e.target.value);
                        setOtherError(false);
                      }}
                      inputMode={current.other.inputMode}
                      autoComplete="off"
                      placeholder={current.choices.length ? `Other: ${current.other.placeholder}` : current.other.placeholder}
                      aria-invalid={otherError || undefined}
                      className="h-11 min-w-0 flex-1 rounded-pill border border-border bg-surface-1 px-4 text-[16px] md:h-9 md:text-[15px] text-ink outline-none placeholder:text-ink-muted focus-visible:border-border-strong focus-visible:ring-2 focus-visible:ring-focus/40 aria-invalid:border-destructive"
                    />
                    <Button type="submit" size="icon" disabled={!other.trim()} aria-label="Send answer" className="size-11 md:size-9">
                      <CornerDownLeft strokeWidth={1.75} />
                    </Button>
                  </form>
                )}
                <button
                  type="button"
                  onClick={() => answer(current, {}, current.skip)}
                  className="h-11 cursor-pointer rounded-pill px-3 text-[14px] text-ink-muted underline-offset-4 md:h-9 hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-focus"
                >
                  <kbd aria-hidden className="mr-1.5 hidden font-mono text-[11px] md:inline">0</kbd>
                  {current.skip}
                </button>
              </div>
              {otherError && <p className="m-0 text-[13px] text-warning-text">Please enter a number, e.g. {current.other?.placeholder}.</p>}
            </div>
          )}
        </div>
      </section>

      {/* ── Right: the house builds as you answer, the draft under it ─────────────────── */}
      <section aria-label="The house" className="contents lg:order-2 lg:flex lg:min-h-0 lg:flex-col lg:gap-3">
        <div className="order-3">
          <Stage {...stage} />
        </div>
        <div
          aria-labelledby="intake-draft-t"
          className={cn(
            "order-5 flex shrink-0 flex-col justify-between gap-3 rounded-lg border bg-surface-1 px-4 py-3.5 md:px-5 lg:h-[188px]",
            design
              ? "border-[1.5px] border-transparent [background:linear-gradient(var(--surface-1),var(--surface-1))_padding-box,linear-gradient(90deg,var(--ai-amber),var(--ai-orange),var(--ai-salmon))_border-box]"
              : "border-border",
          )}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="intake-draft-t" className="m-0 text-[15px] font-semibold">
              Draft design
            </h2>
            <div className="flex items-center gap-2">
              {loading && <span className="text-[13px] text-ink-muted">Updating…</span>}
              <ServedBadge served={design?.served} />
              {design && <StatusBadge tone="ai">Drafted by AI</StatusBadge>}
            </div>
          </div>
          {design ? (
            <dl className="m-0 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
              {COMPONENTS.map((c) => {
                const v = sizeOf(design.design, c);
                const hp = c === "heatpump" && v == null && design.options?.heatpump?.available ? design.options.heatpump.kw : null;
                const shown = v ?? hp;
                return (
                  <div key={c} className="flex min-w-0 flex-col gap-1">
                    <dt className="flex items-center gap-2 text-[13px] text-ink-muted">
                      <span className={cn("size-2 shrink-0 rounded-full", DOT[c])} aria-hidden />
                      {LABEL[c]}
                      {hp != null && <span className="rounded-full bg-surface-2 px-1.5 text-[11px] leading-4 font-medium text-ink-body">Option</span>}
                    </dt>
                    <dd className={cn("m-0 flex items-baseline gap-1.5 font-mono tabular", shown == null && "text-ink-muted")}>
                      <span key={`${shown}`} className="-mx-1 animate-value-changed px-1 text-[clamp(22px,2.2vw,30px)] leading-none font-medium">
                        {shown == null ? <span className="font-sans text-[17px] font-normal">None</span> : c === "pv" ? kwp.format(shown) : short.format(shown)}
                      </span>
                      {shown != null && <span className="text-[13px] text-ink-muted">{UNIT[c]}</span>}
                    </dd>
                  </div>
                );
              })}
            </dl>
          ) : (
            <p className="m-0 text-body-sm text-ink-muted">Appears as soon as the bill, the yearly use or the household size is known. Every size comes from the engine.</p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="m-0 text-[13px] text-ink-muted">
              {savedId ? "Saved to the planner's inbox for review." : finished && saving ? "Saving the draft…" : "Lands in the planner's inbox when the questions are done."}
            </p>
            {!savedId && saveFailed === answersKey && (
              <Button variant="secondary" onClick={() => setSaveFailed(null)}>
                Try saving again
              </Button>
            )}
            {savedId && (
              <Button render={<Link href={`/?d=${savedId}`} />} nativeButton={false}>
                <Check data-icon="inline-start" strokeWidth={2} /> Open in planner
              </Button>
            )}
          </div>
        </div>
      </section>
    </main>
  );
}
