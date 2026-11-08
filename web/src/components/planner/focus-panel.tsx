"use client";

import { ArrowRight, X } from "lucide-react";
import { Segmented } from "@/components/ui/field";
import { sizeOf } from "@/lib/diff";
import { fmtInt, fmtValue, LABEL, UNIT } from "@/lib/format";
import type { ComponentKey, DesignResponse } from "@/lib/types";
import { cn } from "@/lib/utils";
import type { InsideKey, Zone } from "@/components/house3d/insideRules";
import { compareRows, insideKeyOf, wantLock, wants, zoneChoices, zoneOf, type CompareRow } from "./focus-logic";
import { Editor, ICON, TEXT_COLOR } from "./system-card";

const heading = "m-0 text-[12px] font-medium tracking-[0.06em] text-ink-muted uppercase";

/**
 * The part the planner clicked on the house, as its own small product: want it, where it goes, which size, and what
 * that changes. Every size comes from the engine (its own answer, the options it offered, the installer's catalogue);
 * picking one locks it and re-runs the engine.
 */
export function FocusPanel({
  component: c,
  response: r,
  before,
  busy,
  zones,
  onZones,
  onLock,
  onClose,
}: {
  component: ComponentKey;
  response: DesignResponse;
  /** The design before the planner's last change from this panel (for before → after). */
  before: DesignResponse | null;
  busy: boolean;
  zones: Partial<Record<InsideKey, Zone>>;
  onZones: (z: Partial<Record<InsideKey, Zone>>) => void;
  onLock: (value: number | boolean | null, reason: string | null) => void;
  onClose: () => void;
}) {
  const Icon = ICON[c];
  const size = sizeOf(r.design, c);
  const on = wants(c, r);
  const yesLock = wantLock(c, r, true, before);
  const hpOption = c === "heatpump" && r.options?.heatpump?.available ? r.options.heatpump.kw : null;
  const where = zoneOf(c, zones);
  const k = insideKeyOf(c);
  const rows = before ? compareRows(c, before, r) : null;
  const changed = rows?.some((x) => x.before !== x.after);

  return (
    <section
      id="focus-panel"
      aria-label={`${LABEL[c]}: your choices`}
      className="flex scroll-mt-24 flex-col gap-4 rounded-md border border-border-strong bg-surface-1 p-4 shadow-[0_1px_2px_rgba(16,17,20,0.05)] animate-in fade-in motion-safe:slide-in-from-top-1 duration-200"
    >
      <header className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-surface-2" aria-hidden>
          <Icon className={cn("size-[18px]", TEXT_COLOR[c])} strokeWidth={1.5} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 className="m-0 text-h3">{LABEL[c]}</h2>
          <p className="m-0 font-mono text-[15px] tabular text-ink-body">
            {size ? `${fmtValue(c, size)} ${UNIT[c]}` : hpOption ? `Option · ${fmtValue(c, hpOption)} ${UNIT[c]}` : "Not included"}
            {busy && <span className="ml-2 font-sans text-[12px] text-ink-muted">Recalculating…</span>}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="grid size-8 cursor-pointer place-items-center rounded-full text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-focus"
        >
          <X className="size-4" strokeWidth={1.75} />
        </button>
      </header>

      {c !== "pv" && (
        <div className="flex flex-col gap-2">
          <h3 className={heading}>Want it?</h3>
          <Segmented
            label={`Include the ${LABEL[c].toLowerCase()}`}
            value={on ? "yes" : "no"}
            onChange={(v) => {
              const lock = wantLock(c, r, v === "yes", before);
              if (lock !== null && v !== (on ? "yes" : "no")) onLock(lock, v === "yes" ? `added the ${LABEL[c].toLowerCase()}` : `no ${LABEL[c].toLowerCase()}`);
            }}
            options={[
              { value: "yes", label: yesLock === null && !on ? "Yes · pick a size" : "Yes" },
              { value: "no", label: "No" },
            ]}
            className="self-start"
          />
        </div>
      )}

      <div className="flex flex-col gap-2">
        <h3 className={heading}>Where?</h3>
        {c === "pv" && (
          <p className="m-0 text-[13px] leading-5 text-ink-body">
            Sunniest roof face first, then the next one.
          </p>
        )}
        <div role="radiogroup" aria-label={c === "pv" ? "Where the inverter goes" : `Where the ${LABEL[c].toLowerCase()} goes`} className="flex flex-wrap gap-1.5">
          {c === "pv" && <span className="self-center pr-1 text-[13px] text-ink-muted">Inverter</span>}
          {zoneChoices(c).map((z) => (
            <button
              key={z.zone}
              type="button"
              role="radio"
              aria-checked={where === z.zone}
              disabled={!z.allowed}
              title={z.why || undefined}
              onClick={() => onZones({ ...zones, [k]: z.zone })}
              className={cn(
                "h-8 cursor-pointer rounded-pill border px-3 text-[13px] font-medium transition-[background-color,border-color,color] duration-150 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-45",
                where === z.zone ? "border-ink bg-ink text-surface-1" : "border-border bg-surface-1 text-ink-body enabled:hover:border-border-strong enabled:hover:text-ink",
              )}
            >
              {z.label}
            </button>
          ))}
        </div>
      </div>

      {(on || c === "pv" || c === "battery" || hpOption) && (
        <div className="flex flex-col gap-2">
          <h3 className={heading}>Which size?</h3>
          {/* the card's own editor: engine sizes plus the installer's catalogue; applying locks it and re-runs the engine */}
          <Editor key={`${c}-${size ?? "none"}`} component={c} response={r} onApply={(v, reason) => onLock(v, reason)} onCancel={onClose} />
        </div>
      )}

      {rows && changed && (
        <div className="flex flex-col gap-2" aria-live="polite">
          <h3 className={heading}>What changed</h3>
          <dl className="m-0 grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1.5 text-[13px]">
            {rows.map((row) => (
              <Compare key={row.label} row={row} />
            ))}
          </dl>
        </div>
      )}
    </section>
  );
}

function fmt(row: CompareRow, v: number | null) {
  if (v == null) return "–";
  if (row.unit === "€") return `€${fmtInt(v)}`;
  if (row.unit === "%") return `${v} %`;
  if (row.unit === "kWh / yr") return `${fmtInt(v)} kWh`;
  return `${v} ${row.unit}`;
}

function Compare({ row }: { row: CompareRow }) {
  const same = row.before === row.after;
  const up = (row.after ?? 0) > (row.before ?? 0);
  return (
    <>
      <dt className="text-ink-body">{row.label}</dt>
      <dd className="m-0 flex items-center justify-end gap-1.5 font-mono tabular">
        {same ? (
          <span className="text-ink-muted">{fmt(row, row.after)}</span>
        ) : (
          <>
            <s className="text-ink-muted decoration-1">{fmt(row, row.before)}</s>
            <ArrowRight className="size-3 text-ink-muted" strokeWidth={2} aria-label="to" />
            <span className={cn("font-medium", row.better ? (up ? "text-success-text" : "text-warning-text") : "text-ink")}>{fmt(row, row.after)}</span>
          </>
        )}
      </dd>
    </>
  );
}
