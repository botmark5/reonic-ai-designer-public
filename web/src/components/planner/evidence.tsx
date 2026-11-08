"use client";

import { useEffect, useState } from "react";
import { MiniMarkdown } from "@/components/ui/mini-markdown";
import { StatusBadge } from "@/components/ui/status-badge";
import { fmtEur, fmtInt, fmtKwp, fmtPct } from "@/lib/format";
import type { DesignResponse, ValidationFlag } from "@/lib/types";

const card = "flex flex-col gap-2 rounded-md border border-border bg-surface-1 p-4";
const title = "text-label uppercase text-ink-muted";

/** Streams the engine's planner explanation (Claude on the engine side, template fallback). */
export function WhyThisDesign({ response }: { response: DesignResponse | null }) {
  const [text, setText] = useState("");
  const [state, setState] = useState<"idle" | "loading" | "streaming" | "done" | "error">("idle");
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!response) return;
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      setState("loading");
      setText("");
      try {
        const res = await fetch("/api/engine/explain", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ design_response: response, audience: "planner" }),
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) throw new Error();
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        setState("streaming");
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          setText((x) => x + dec.decode(value, { stream: true }));
        }
        setState("done");
      } catch {
        if (!ctrl.signal.aborted) setState("error");
      }
    }, 350);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [response]);

  return (
    <section className={card} aria-labelledby="why-t" aria-busy={state === "loading" || state === "streaming"}>
      <h2 id="why-t" className={title}>
        Why this design
      </h2>
      {state === "loading" || (state === "idle" && !text) ? (
        <div className="flex flex-col gap-2 py-1" aria-label="Writing the explanation">
          {[100, 92, 97, 60].map((w, i) => (
            <span key={i} className="h-3 animate-pulse rounded-sm bg-surface-2 motion-reduce:animate-none" style={{ width: `${w}%` }} />
          ))}
        </div>
      ) : state === "error" && !text ? (
        <p className="m-0 text-body-sm text-ink-muted">The explanation is not available right now. Every reason is still on the cards.</p>
      ) : (
        <>
          <div
            className={`relative text-[14px] leading-[21px] text-ink-body ${expanded ? "" : "max-h-[220px] overflow-hidden"}`}
            aria-live="polite"
          >
            <MiniMarkdown text={text} />
            {state === "streaming" && <span className="mt-1 inline-block h-3.5 w-1.5 animate-pulse bg-ai-orange motion-reduce:animate-none" aria-hidden />}
            {!expanded && text.length > 600 && (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-surface-1 to-transparent" aria-hidden />
            )}
          </div>
          {text.length > 600 && (
            <button
              type="button"
              onClick={() => setExpanded((x) => !x)}
              aria-expanded={expanded}
              className="cursor-pointer self-start rounded-pill text-[13px] font-medium text-ink-body underline-offset-4 hover:text-ink hover:underline"
            >
              {expanded ? "Show less" : "Show all"}
            </button>
          )}
        </>
      )}
    </section>
  );
}

export function SimilarHomes({ response }: { response: DesignResponse }) {
  const rows = response.similar_homes;
  return (
    <section className={card} aria-labelledby="sim-t">
      <h2 id="sim-t" className={title}>
        Similar homes
      </h2>
      {rows.length === 0 ? (
        <p className="m-0 text-body-sm text-ink-muted">No similar homes for this installer yet.</p>
      ) : (
        <table className="w-full border-collapse text-[13px]">
          <caption className="sr-only">Nearest past projects of this installer and what the expert sold</caption>
          <thead>
            <tr className="text-[11px] leading-[14px] text-ink-muted">
              <th scope="col" className="border-b border-border py-1.5 text-left font-medium">Home</th>
              <th scope="col" className="border-b border-border py-1.5 text-right font-medium">kWh / yr</th>
              <th scope="col" className="border-b border-border py-1.5 text-right font-medium">PV kWp</th>
              <th scope="col" className="border-b border-border py-1.5 text-right font-medium">Battery</th>
            </tr>
          </thead>
          <tbody className="font-mono text-data tabular">
            {rows.map((h) => (
              <tr key={h.project_id} className="border-b border-surface-2 last:border-0">
                <td className="py-[7px] text-left font-sans">
                  {Math.round(h.similarity * 100)} % similar
                </td>
                <td className="py-[7px] text-right">{fmtInt(h.annual_kwh)}</td>
                <td className="py-[7px] text-right">{h.pv_kwp ? fmtKwp(h.pv_kwp) : "–"}</td>
                <td className="py-[7px] text-right">{h.battery_kwh ? `${h.battery_kwh}` : "–"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function PhysicsTiles({ response, flags }: { response: DesignResponse; flags: ValidationFlag[] }) {
  const p = response.physics;
  const e = response.economics;
  const issues = Array.from(
    new Set([
      ...flags.filter((f) => f.level === "warn" || f.level === "error").map((f) => f.message.replace(/^\[mock\]\s*/, "")),
      ...(p.flags ?? []).filter((f) => f.level === "warn" || f.level === "error").map((f) => f.message),
    ]),
  );
  const tile = (label: string, value: React.ReactNode, hint?: string) => (
    <div className="flex flex-col gap-0.5" title={hint}>
      <span className="text-[12px] text-ink-muted">{label}</span>
      <span className="font-mono text-[15px] font-medium tabular">{value}</span>
    </div>
  );
  return (
    <section className="rounded-md border border-border bg-surface-1 p-4" aria-label="Physics check">
      <div className="grid grid-cols-2 gap-3">
        {tile("Solar yield", p.yield_kwh ? `≈ ${fmtInt(p.yield_kwh)} kWh` : "–", "Simulated hourly over a year")}
        {tile("Own use", p.yield_kwh ? `${fmtPct(p.self_consumption)} %` : "–", "Share of solar power used in the home")}
        {tile("Self-sufficiency", `${fmtPct(p.autarky)} %`, "Share of the yearly demand covered by solar + battery")}
        <div className="flex flex-col gap-0.5">
          <span className="text-[12px] text-ink-muted">Checks</span>
          {issues.length === 0 ? (
            <StatusBadge tone="success" className="self-start">
              All plausible
            </StatusBadge>
          ) : (
            <StatusBadge tone="warning" className="self-start" title={issues.join("\n")}>
              {issues.length} to review
            </StatusBadge>
          )}
        </div>
      </div>
      {issues.length > 0 && (
        <ul className="mt-3 flex list-none flex-col gap-1 border-t border-border p-0 pt-3 text-[13px] leading-[18px] text-warning-text">
          {issues.slice(0, 3).map((m, i) => (
            <li key={i}>{m}</li>
          ))}
        </ul>
      )}
      {e && (
        <p className="mt-3 mb-0 border-t border-border pt-3 text-[12px] leading-4 text-ink-muted">
          <span className="font-mono text-ink tabular">{fmtEur(e.capex_total_eur)}</span> investment ·{" "}
          <span className="font-mono text-ink tabular">{fmtEur(e.savings_first_year_eur)}</span> saved in year one
          {e.payback_years ? (
            <>
              {" "}
              · pays back in <span className="font-mono text-ink tabular">{e.payback_years}</span> years
            </>
          ) : null}
          . Placeholder prices.
        </p>
      )}
      {(p.assumptions ?? []).length > 0 && (
        <p className="mt-2 mb-0 text-[12px] leading-4 text-ink-muted">Assumed: {(p.assumptions ?? []).map((a) => a.replace(/\.$/, "")).join("; ")}.</p>
      )}
    </section>
  );
}
