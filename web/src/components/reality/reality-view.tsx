"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Shuffle } from "lucide-react";
import { HouseStage } from "@/components/house3d";
import { Button } from "@/components/ui/button";
import { ServedBadge } from "@/components/ui/served-badge";
import { StatusBadge, type Tone } from "@/components/ui/status-badge";
import { COMPONENTS, sizeOf } from "@/lib/diff";
import { fmtInt, fmtKwp, fmtSize, LABEL } from "@/lib/format";
import type { DemoProject } from "@/lib/heldout";
import { ADDON_HEADLINES, caseChips, expertDesign, headlines, headlineSource, top3, trustedCoverage, verdicts, type Headline, type VerdictKind } from "@/lib/reality";
import type { ComponentKey, EvalResponse, ExpertVariant, MetricSet, ProjectResponse } from "@/lib/types";
import { PREDICTORS } from "@/lib/types";
import { cn } from "@/lib/utils";
import { bandRows, installerOrder, transferRows } from "@/lib/deviation";

const DOT: Record<ComponentKey, string> = { pv: "bg-comp-pv", battery: "bg-comp-battery", wallbox: "bg-comp-wallbox", heatpump: "bg-comp-heatpump" };
const TONE: Record<VerdictKind, Tone> = { match: "success", range: "success", close: "success", option: "success", off: "warning", missing: "critical", extra: "critical" };


function Verdict({ t, short = false }: { t: Headline; short?: boolean }) {
  if (t.level) return <StatusBadge tone="neutral">{short ? "Level" : "Level with rule"}</StatusBadge>;
  if (t.wins == null) return null;
  return <StatusBadge tone={t.wins ? "success" : "warning"}>{t.wins ? (short ? "Better" : "Better than rules") : short ? "Below" : "Below simple rule"}</StatusBadge>;
}

function oursCell(c: ComponentKey, p: ProjectResponse | null) {
  const d = p?.ours?.design;
  if (!d) return "–";
  if (c === "heatpump" && !d.heatpump.include && p?.ours?.options?.heatpump?.available) return <span className="font-sans">Option {p.ours.options.heatpump.kw} kW</span>;
  return fmtSize(c, sizeOf(d, c));
}

const n = (m: MetricSet | undefined, k: string) => (m && typeof m[k] === "number" ? (m[k] as number) : null);
const pct = (x: number | null) => (x == null ? "–" : `${Math.round(x)}`);
const kwp = (x: number | null) => (x == null ? "–" : x.toFixed(1));

function expertCell(c: ComponentKey, variants: ExpertVariant[]) {
  const val = (v: ExpertVariant) =>
    c === "pv" ? v.pv_kwp : c === "battery" ? v.battery_kwh : c === "heatpump" ? v.heatpump_kw : v.has_wallbox ? 11 : 0;
  const vals = Array.from(new Set(variants.map((v) => val(v) ?? 0))).sort((a, b) => a - b);
  if (c === "wallbox") return vals.some((x) => x > 0) ? (vals.length > 1 ? "Yes or no" : "Wallbox") : "None";
  const shown = vals.filter((x) => x > 0);
  if (!shown.length) return "None";
  if (shown.length === 1) return fmtSize(c, shown[0]);
  return (
    <>
      {shown.map((x) => (c === "pv" ? fmtKwp(x) : x)).join(" · ")} {c === "pv" ? "kWp" : c === "battery" ? "kWh" : "kW"}{" "}
      <span className="text-ink-muted">({variants.length} options)</span>
    </>
  );
}

function describeHome(p: ProjectResponse) {
  const h = p.home;
  return [
    `${fmtInt(h.annual_kwh)} kWh`,
    h.has_ev ? "EV" : "no EV",
    h.heating ? h.heating.toLowerCase() : null,
    h.existing_pv_kwp ? `${h.existing_pv_kwp} kWp existing PV` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

const subscribeWide = (cb: () => void) => {
  const m = window.matchMedia("(min-width: 768px)");
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
};
const useWide = () => useSyncExternalStore(subscribeWide, () => window.matchMedia("(min-width: 768px)").matches, () => false);

export function RealityView({ evalRes, ids, demos: allDemos }: { evalRes: EvalResponse; ids: string[]; demos: DemoProject[] }) {
  const demos = useMemo(() => caseChips(allDemos), [allDemos]);
  const wide = useWide();
  const [projectId, setProjectId] = useState<string | null>(demos[0]?.project_id ?? ids[0] ?? null);
  const [history, setHistory] = useState<string[]>([]);
  const [project, setProject] = useState<ProjectResponse | null>(null);
  const [errorId, setErrorId] = useState<string | null>(null);
  const [manual, setManual] = useState("");
  // what-if: the planner answered "Solar already on the roof?" (engine #47). Off by default: the answer is derived from
  // the expert offer in this test, so it shows what the question is worth, never an accuracy.
  const [withAnswer, setWithAnswer] = useState(false);

  useEffect(() => {
    if (!projectId) return;
    const ctrl = new AbortController();
    fetch(`/api/engine/project/${encodeURIComponent(projectId)}${withAnswer ? "?answered=1" : ""}`, { signal: ctrl.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error();
        setProject({ ...(await r.json()), project_id: projectId });
      })
      .catch(() => !ctrl.signal.aborted && setErrorId(projectId));
    return () => ctrl.abort();
  }, [projectId, withAnswer]);
  const switchAnswered = (on: boolean) => {
    if (on === withAnswer) return;
    setErrorId(null);
    setProject(null);
    setWithAnswer(on);
  };

  const go = useCallback(
    (id: string) => {
      if (projectId) setHistory((h) => [...h.slice(-20), projectId]);
      setErrorId(null);
      setProjectId(id);
    },
    [projectId],
  );

  const random = () => {
    if (!ids.length) return;
    let id = ids[Math.floor(Math.random() * ids.length)];
    if (id === projectId && ids.length > 1) id = ids[(ids.indexOf(id) + 1) % ids.length];
    go(id);
  };

  const state: "idle" | "loading" | "error" =
    projectId && errorId === projectId ? "error" : projectId && project?.project_id !== projectId ? "loading" : "idle";
  const demo = demos.find((d) => d.project_id === projectId);
  // the retrofit case without the answer: the engine cannot know the expert only added a battery (engine #47)
  const unanswered =
    !withAnswer && demo?.role === "battery_retrofit" && project?.project_id === projectId && project?.ours?.facts_for_explanation?.offer_type !== "battery_retrofit";
  const shownAnswer = project?.project_id === projectId && project?.answered ? project.planner_answer : undefined;
  const catalogue = ((evalRes.protocol?.catalogue as Record<string, number[]> | undefined) ?? {})[project?.installer ?? ""] ?? [];
  const ours = project?.ours?.design ?? null;
  const v =
    project && ours
      ? verdicts(
          {
            pv: sizeOf(ours, "pv"),
            battery: sizeOf(ours, "battery"),
            wallbox: ours.wallbox.include,
            heatpump: sizeOf(ours, "heatpump"),
            heatpumpOption: project.ours?.options?.heatpump?.available ? project.ours.options.heatpump.kw : null,
          },
          project.variants,
          catalogue,
        )
      : null;

  const M = evalRes.metrics[PREDICTORS.model];
  const offline = evalRes.served?.source === "offline";
  // Headline = new full systems when the engine reports that slice (else all projects); add-on sales separately.
  const src = headlineSource(evalRes as Parameters<typeof headlineSource>[0]);
  const HM = src.metrics[PREDICTORS.model] as MetricSet | undefined;
  const heads = headlines(src.metrics);
  const addOns = src.addOns ? headlines(src.addOns, PREDICTORS.model, ADDON_HEADLINES) : [];
  const nAddOns = src.addOns ? n(src.addOns[PREDICTORS.model] as MetricSet, "n_projects") : null;
  // Shown only when /eval reports coverage (engine #43). 80 % is not an engine number: a P10–P90 range should hold 90 − 10 = 80 % by definition.
  const cov = trustedCoverage(HM) ?? trustedCoverage(src.overall[PREDICTORS.model]);
  const top3Pct = top3(HM);
  const bands = bandRows(evalRes.by_band);
  const transfers = transferRows(evalRes.transfer, PREDICTORS.model, PREDICTORS.bandMedian, installerOrder(evalRes.by_installer, PREDICTORS.model));
  const addOnCov = src.addOns ? trustedCoverage(src.addOns[PREDICTORS.model]) : null; // null or < 20 homes: no row
  const answered = evalRes.with_existing_pv_answer?.metrics?.[PREDICTORS.model];
  const fmt = (x: number | null, unit: "kWp" | "%") => (x == null ? "–" : unit === "kWp" ? x.toFixed(2) : `${Math.round(x)}`);
  const nTest = n(HM, "n_projects") ?? (src.fullOnly ? null : ((evalRes.protocol?.n_test as number | undefined) ?? null));
  const nAll = n(M, "n_projects") ?? (evalRes.protocol?.n_test as number | undefined) ?? null;
  const [headline, ...otherHeads] = heads;
  // on new full systems nearly every home has solar on both sides: the "where both chose solar" tile repeats the headline
  const restHeads = otherHeads.filter((t) => !(t.key === "pv_kwp_mae_when_both_pv" && headline && fmt(t.ours, t.unit) === fmt(headline.ours, headline.unit)));
  const noNewSolar = addOns.find((t) => t.key === "has_pv_accuracy");
  const otherAddOns = addOns.filter((t) => t !== noNewSolar);
  const shown = project && project.project_id === projectId ? project : null;
  const theirs = shown?.ours ? expertDesign(shown.ours, shown.variants) : null;

  return (
    <main id="main" className="mx-auto flex w-full max-w-[1200px] flex-1 flex-col gap-10 px-4 py-8 md:px-6 md:py-12">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <ServedBadge served={evalRes.served} />
          {offline && <span className="text-body-sm text-ink-muted">Engine offline: no numbers are shown until it is reachable again.</span>}
        </div>
        <h1 className="m-0 text-[clamp(32px,4vw,48px)] leading-none font-normal tracking-[-0.02em]">Does it design like your experts?</h1>
        <p className="m-0 max-w-2xl text-body text-ink-body">Every result below the two houses comes from homes the engine never saw while learning.</p>
      </header>

      <section aria-labelledby="one-home" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <h2 id="one-home" className="m-0 text-label uppercase text-ink-muted">One past home</h2>
            <p className="m-0 text-body-sm text-ink-body" aria-live="polite">
              {project ? describeHome(project) : projectId ? "Loading…" : "No held-out projects available"}
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" disabled={!history.length} onClick={() => setHistory((h) => (setErrorId(null), setProjectId(h[h.length - 1]), h.slice(0, -1)))}>
              Previous
            </Button>
            <Button variant="secondary" size="sm" disabled={!ids.length} onClick={random}>
              <Shuffle data-icon="inline-start" strokeWidth={1.5} /> Random home
            </Button>
          </div>
        </div>

        {demos.length > 0 && (
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Example cases">
            {demos.map((d) => (
              <button
                key={d.project_id}
                type="button"
                onClick={() => go(d.project_id)}
                aria-pressed={d.project_id === projectId}
                title={d.why}
                className={cn(
                  "h-8 cursor-pointer rounded-pill border px-3 text-[13px] transition-colors",
                  d.project_id === projectId ? "border-ink bg-ink text-surface-0" : "border-border bg-surface-1 text-ink-body hover:border-border-strong hover:text-ink",
                )}
              >
                {d.label}
              </button>
            ))}
          </div>
        )}

        {state === "error" ? (
          <p className="m-0 rounded-lg border border-dashed border-border bg-surface-1 p-6 text-body-sm text-critical-text">
            This home could not be loaded: the engine is offline or does not know this id. No example values are shown in its place.
          </p>
        ) : (
          <div className={cn("flex flex-col gap-4", state === "loading" && "opacity-60 transition-opacity")} aria-busy={state === "loading"}>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {(["ours", "expert"] as const).map((side) => {
                const design = side === "ours" ? (shown?.ours ?? null) : theirs;
                return (
                  <figure key={side} className="m-0 flex min-w-0 flex-col gap-2">
                    <figcaption className="flex items-center gap-2 text-[15px] font-medium text-ink">
                      <span className={cn("size-2 rounded-full", side === "ours" ? "bg-ai-orange" : "bg-ink")} aria-hidden />
                      {side === "ours" ? "Our design" : "What the expert sold"}
                    </figcaption>
                    {design && shown ? (
                      <HouseStage
                        design={design}
                        home={shown.home}
                        mode="planner"
                        cameraKey="reality"
                        view="outside"
                        controls="minimal"
                        // size chips on each house (c-3d), so the two systems compare at a glance; phones keep the clean house
                        labels={wide}
                      />
                    ) : (
                      <div className="aspect-[4/3] w-full animate-pulse rounded-lg border border-border bg-surface-1 motion-reduce:animate-none md:aspect-[16/10]" aria-hidden />
                    )}
                  </figure>
                );
              })}
            </div>

            <table className="w-full border-collapse rounded-lg bg-surface-1 text-[14px] [&_td]:px-3 md:text-[15px]">
              <caption className="sr-only">Our design and the expert&apos;s sale, per component, with the verdict</caption>
              <thead>
                <tr className="border-b border-border text-[12px] text-ink-muted">
                  <th scope="col" className="px-3 pt-3 pb-2 text-right font-medium">Our design</th>
                  <th scope="col" className="px-3 pt-3 pb-2 text-center font-medium"><span className="sr-only">Component and verdict</span></th>
                  <th scope="col" className="px-3 pt-3 pb-2 text-left font-medium">Expert sold</th>
                </tr>
              </thead>
              <tbody>
                {COMPONENTS.map((c) => (
                  <tr key={c} className="border-b border-border last:border-0">
                    <td className="w-[38%] py-3 text-right font-mono font-medium tabular">{oursCell(c, shown)}</td>
                    <td className="py-3">
                      <span className="flex flex-col items-center gap-1 text-center">
                        <span className="flex items-center gap-1.5 text-[12px] text-ink-muted">
                          <span className={cn("size-2 rounded-full", DOT[c])} aria-hidden />
                          {LABEL[c]}
                        </span>
                        {v && shown ? <StatusBadge tone={TONE[v[c].kind]}>{v[c].label}</StatusBadge> : null}
                      </span>
                    </td>
                    <td className="w-[38%] py-3 text-left font-mono font-medium tabular">{shown ? expertCell(c, shown.variants) : "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Solar question">
          <span className="text-[13px] text-ink-muted">“Solar already on the roof?”</span>
          {([false, true] as const).map((on) => (
            <button
              key={String(on)}
              type="button"
              onClick={() => switchAnswered(on)}
              aria-pressed={withAnswer === on}
              className={cn(
                "h-7 cursor-pointer rounded-pill border px-2.5 text-[12px] transition-colors",
                withAnswer === on ? "border-ink bg-ink text-surface-0" : "border-border bg-surface-1 text-ink-body hover:border-border-strong hover:text-ink",
              )}
            >
              {on ? "Planner answered (what-if)" : "Not asked, as recorded"}
            </button>
          ))}
        </div>
        {unanswered && (
          <p className="m-0 rounded-md bg-warning-tint px-3 py-2 text-[13px] leading-5 text-warning-text">
            Unanswered: this design was made without the answer to “Solar already on the roof?”, so the engine cannot know the
            expert only added a battery. Switch to “Planner answered” to see the design with the answer.
          </p>
        )}
        {withAnswer && shown && (
          <p className="m-0 rounded-md bg-surface-2 px-3 py-2 text-[13px] leading-5 text-ink-body">
            What-if: the planner answered{" "}
            <b>{shownAnswer == null ? "unknown" : shownAnswer ? "yes, there is solar on the roof" : "no, a new system"}</b>. In this
            test the answer is taken from the expert&apos;s own offer, so it shows what the question is worth when answered
            correctly, not an accuracy. That is why the planner form and the voice agent ask it first.
          </p>
        )}
        <p className="m-0 text-[13px] leading-5 text-ink-muted">
          Our design here is the shipped engine, which learned from all past projects, this one included: a picture of how it
          designs, not a test. The held-out results are the numbers below.{" "}
          {demo ? `${demo.why}. ` : ""}
          {shown && shown.variants.length > 1
            ? `The expert offered ${shown.variants.length} variants for this home; the house shows the main one, and any proposal inside that range counts as a hit.`
            : "Solar counts as a match within 1 kWp, a battery within one catalogue size step."}
        </p>
        <form
          className="flex max-w-sm gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (manual.trim()) go(manual.trim());
          }}
        >
          <label htmlFor="pid" className="sr-only">Project ID</label>
          <input
            id="pid"
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            placeholder="Open a past project by ID"
            className="h-8 min-w-0 flex-1 rounded-sm border border-border bg-surface-1 px-2.5 font-mono text-[13px] outline-none focus-visible:border-focus focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-1 focus-visible:outline-focus/60"
          />
          <Button type="submit" size="sm" variant="ghost">Open</Button>
        </form>
      </section>

      <section aria-labelledby="across" className="flex flex-col gap-4">
        <h2 id="across" className="m-0 text-label uppercase text-ink-muted">
          Across {nTest ? fmtInt(nTest) : "all"} held-out {src.fullOnly ? "new systems" : "homes"}
        </h2>
        {offline ? (
          <div className="rounded-lg border border-dashed border-border bg-surface-1 p-6 text-body-sm text-ink-muted">
            Engine offline: the held-out metrics appear here as soon as it is reachable again. No numbers are shown in the meantime.
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {headline && (
                <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface-1 p-5 md:p-6">
                  <div className="flex flex-wrap-reverse items-start justify-between gap-2">
                    <span className="min-w-[14ch] flex-1 text-[15px] leading-5 font-medium text-ink">
                      {src.fullOnly ? "Solar size error on new full systems" : headline.label}
                    </span>
                    <Verdict t={headline} />
                  </div>
                  <span className="flex flex-wrap items-baseline gap-x-3 font-mono font-medium tabular">
                    <span className="text-[56px] leading-none tracking-[-0.02em]">{fmt(headline.ours, headline.unit)}</span>
                    <span className="text-[20px] text-ink-muted">{headline.unit}</span>
                    <span className="text-[20px] font-normal text-ink-muted">vs {fmt(headline.base, headline.unit)} best rule</span>
                  </span>
                  <span className="text-[13px] leading-5 text-ink-muted">
                    {headline.level ? "Level with the best simple rule" : "Best simple rule"}
                    {headline.baseName ? ` (${headline.baseName})` : ""}. {headline.note ?? ""} Scored with the planner saying “new system”, the same answer for every home here.
                  </span>
                </div>
              )}
              {noNewSolar && (
                <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface-1 p-5 md:p-6">
                  <div className="flex flex-wrap-reverse items-start justify-between gap-2">
                    <span className="min-w-[14ch] flex-1 text-[15px] leading-5 font-medium text-ink">
                      Add-on sales{nAddOns ? ` (${fmtInt(nAddOns)} homes)` : ""}: {noNewSolar.label.toLowerCase()}
                    </span>
                    <Verdict t={noNewSolar} />
                  </div>
                  <span className="flex flex-wrap items-baseline gap-x-3 font-mono font-medium tabular">
                    <span className="text-[56px] leading-none tracking-[-0.02em]">{fmt(noNewSolar.ours, "%")}</span>
                    <span className="text-[20px] text-ink-muted">%</span>
                    <span className="text-[20px] font-normal text-ink-muted">vs {fmt(noNewSolar.base, "%")} % best rule</span>
                  </span>
                  <span className="text-[13px] leading-5 text-ink-muted">
                    Battery retrofits, extensions, wallbox only: the rules put new panels on every roof. Scored without the answer to “Solar already on the roof?”.
                  </span>
                  {otherAddOns.map((t) => (
                    <div key={t.key} className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2 text-[13px]">
                      <span className="text-ink-body">{t.label}</span>
                      <span className="flex items-center gap-2">
                        <span className="font-mono tabular">{fmt(t.ours, t.unit)} %</span>
                        <span className="text-ink-muted">vs {fmt(t.base, t.unit)} %</span>
                        <Verdict t={t} short />
                      </span>
                    </div>
                  ))}
                  {addOnCov != null && (
                    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2 text-[13px]">
                      <span className="text-ink-body">Expert solar inside our P10–P90 range, where both chose solar</span>
                      <span className="font-mono tabular">{Math.round(addOnCov)} %</span>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[repeat(auto-fit,minmax(200px,1fr))]">
              {restHeads.map((t) => (
                <div key={t.key} className="flex flex-col gap-2 rounded-lg border border-border bg-surface-1 p-4">
                  <div className="flex flex-wrap-reverse items-start justify-between gap-2">
                    <span className="min-w-[12ch] flex-1 text-[13px] leading-[18px] text-ink-body">{t.label}</span>
                    <Verdict t={t} short />
                  </div>
                  <span className="font-mono text-[26px] leading-8 font-medium tabular">
                    {fmt(t.ours, t.unit)} <small className="text-[14px] text-ink-muted">{t.unit}</small>
                  </span>
                  <span className="text-[12px] leading-4 text-ink-muted">
                    Best rule: <span className="font-mono tabular">{fmt(t.base, t.unit)} {t.unit}</span>
                    {t.baseName ? ` (${t.baseName})` : ""}
                  </span>
                </div>
              ))}
              {top3Pct != null && (
                <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface-1 p-4">
                  <span className="text-[13px] leading-[18px] text-ink-body">Expert solar among our top 3 options</span>
                  <span className="font-mono text-[26px] leading-8 font-medium tabular">
                    {Math.round(top3Pct)} <small className="text-[14px] text-ink-muted">%</small>
                  </span>
                  <span className="text-[12px] leading-4 text-ink-muted">Within 1.5 kWp of one of the three sizes the planner sees first. No simple rule offers options to compare.</span>
                </div>
              )}
              {cov != null && (
                <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface-1 p-4">
                  <div className="flex flex-wrap-reverse items-start justify-between gap-2">
                    <span className="min-w-[12ch] flex-1 text-[13px] leading-[18px] text-ink-body">Expert solar inside our P10–P90 range</span>
                    <StatusBadge tone={Math.abs(cov - 80) <= 5 ? "success" : "warning"}>
                      {Math.abs(cov - 80) <= 5 ? "Calibrated" : cov < 80 ? "Too narrow" : "Too wide"}
                    </StatusBadge>
                  </div>
                  <span className="font-mono text-[26px] leading-8 font-medium tabular">
                    {Math.round(cov)} <small className="text-[14px] text-ink-muted">%</small>
                  </span>
                  {/* 80 % is not an engine number: a P10–P90 range should hold 90 − 10 = 80 % by definition. */}
                  <span className="text-[12px] leading-4 text-ink-muted">Target 80 %: an honest range holds about 8 in 10 expert choices.</span>
                </div>
              )}
            </div>
          </>
        )}
        {!offline && (bands.length > 0 || transfers.length > 0) && (
          <div className="flex flex-col gap-4 rounded-lg border border-border bg-surface-1 p-5 md:p-6">
            <div className="flex flex-col gap-1">
              <h3 className="m-0 text-[15px] font-medium text-ink">Where we differ from the experts</h3>
              <p className="m-0 text-[12px] leading-4 text-ink-muted">Solar size error where both chose solar, held-out homes, without the answer to “Solar already on the roof?”.</p>
            </div>
            {bands.length > 0 && (
              <table className="w-full border-collapse text-[13px]">
                <caption className="sr-only">Solar size error by yearly consumption</caption>
                <thead>
                  <tr className="text-left text-[12px] text-ink-muted">
                    <th scope="col" className="border-b border-border py-1.5 font-medium">Yearly use</th>
                    <th scope="col" className="border-b border-border py-1.5 text-right font-medium">Homes</th>
                    <th scope="col" className="border-b border-border py-1.5 text-right font-medium">Our error</th>
                    <th scope="col" className="hidden border-b border-border py-1.5 text-right font-medium sm:table-cell">Band median</th>
                    <th scope="col" className="hidden border-b border-border py-1.5 pl-4 font-medium md:table-cell">Why</th>
                  </tr>
                </thead>
                <tbody>
                  {bands.map((r) => (
                    <tr key={r.key} className={cn("border-b border-surface-2 last:border-0", r.hardest && "bg-warning-tint/60")}>
                      <td className="py-2">
                        {r.label}
                        {r.hardest && <span className="ml-2 text-[12px] font-medium text-warning-text">hardest</span>}
                        <span className="mt-0.5 block text-[12px] text-ink-muted md:hidden">{r.sentence}</span>
                      </td>
                      <td className="py-2 text-right font-mono tabular">{fmtInt(r.n)}</td>
                      <td className="py-2 text-right font-mono tabular">{r.ours.toFixed(2)} kWp</td>
                      <td className="hidden py-2 text-right font-mono text-ink-muted tabular sm:table-cell">{r.base == null ? "–" : `${r.base.toFixed(2)} kWp`}</td>
                      <td className="hidden py-2 pl-4 text-ink-body md:table-cell">{r.sentence}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {transfers.length > 0 && (
              <div className="flex flex-col gap-2">
                <span className="text-[13px] font-medium text-ink-body">Learned on one installer, tested on the other</span>
                {transfers.map((t) => (
                  <div key={t.key} className="flex flex-col gap-1 border-t border-border pt-2 text-[13px] sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                    <span className="text-ink-body">{t.sentence}</span>
                    <span className="flex shrink-0 items-center gap-2">
                      <span className="font-mono tabular">{kwp(t.ours)} kWp</span>
                      <span className="text-ink-muted">vs {kwp(t.base)}</span>
                      <StatusBadge tone={t.carries ? "success" : "warning"}>{t.carries ? "Transfers" : "Weaker"}</StatusBadge>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {!offline && answered && (
          <div className="flex flex-col gap-2 rounded-lg border border-border bg-ai-tint/50 p-4">
            <span className="text-[13px] font-medium text-ink">What-if: the planner answers “Solar already on the roof?”</span>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[13px] sm:grid-cols-4">
              {[
                ["Solar size error", "pv_kwp_mae_all_projects", "kWp"],
                ["Solar yes/no", "has_pv_accuracy", "%"],
                ["Battery yes/no", "has_battery_accuracy", "%"],
                ["Offer type", "offer_type_accuracy", "%"],
              ].map(([label, key, unit]) => (
                <div key={key} className="flex flex-col">
                  <span className="text-[12px] text-ink-muted">{label}</span>
                  <span className="font-mono tabular">
                    {fmt(n(M, key), unit as "kWp" | "%")} → <b>{fmt(n(answered, key), unit as "kWp" | "%")}</b> {unit}
                  </span>
                </div>
              ))}
            </div>
            <span className="text-[12px] text-ink-muted">
              All {nAll ? fmtInt(nAll) : ""} held-out homes, add-ons included. Not an accuracy: in this test the answer is derived from the expert offer itself,
              so these numbers show what the question is worth when it is answered correctly, which is why the planner form and the voice agent ask it first.
            </span>
          </div>
        )}
        {!offline && <details className="rounded-lg border border-border bg-surface-1 p-4">
          <summary className="cursor-pointer text-[13px] font-medium text-ink-body">All baselines</summary>
          <table className="mt-3 w-full border-collapse text-[12px]">
            <thead>
              <tr className="text-left text-ink-muted">
                <th scope="col" className="py-1 font-medium">Method</th>
                <th scope="col" className="py-1 text-right font-medium">PV error</th>
                <th scope="col" className="py-1 text-right font-medium">PV in range</th>
                <th scope="col" className="py-1 text-right font-medium">Battery ±1 step</th>
              </tr>
            </thead>
            <tbody className="font-mono tabular">
              {Object.entries(src.metrics as Record<string, MetricSet>).map(([name, m]) => (
                <tr key={name} className={cn("border-t border-surface-2", name === PREDICTORS.model && "font-semibold text-ink")}>
                  <td className="py-1.5 font-sans">{name === PREDICTORS.model ? "Our engine" : name.replace("baseline_", "").replace(/_/g, " ")}</td>
                  <td className="py-1.5 text-right">{kwp(n(m, "pv_kwp_mae_all_projects"))}</td>
                  <td className="py-1.5 text-right">{pct(n(m, "pv_variant_hit_tolerant_pct"))} %</td>
                  <td className="py-1.5 text-right">{pct(n(m, "battery_within_one_step_pct"))} %</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>}
        <p className="m-0 text-[12px] leading-4 text-ink-muted">
          Test set: {nAll ? fmtInt(nAll) : "20 %"} homes ({Math.round(((evalRes.protocol?.test_size as number) ?? 0.2) * 100)} %), split{" "}
          {String(evalRes.protocol?.split ?? "by customer").replace(/\s*\(.*\)/, "").replace("grouped by customer_contact_id", "by customer")}, seed{" "}
          {String(evalRes.protocol?.seed ?? 42)}, locked before training. Labels: {evalRes.labels_source ?? "engine"}.
        </p>
      </section>
    </main>
  );
}
