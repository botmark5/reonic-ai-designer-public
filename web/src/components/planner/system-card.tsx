"use client";

import { useEffect, useRef, useState } from "react";
import { BatteryMedium, Fan, Lock, LockOpen, Minus, PlugZap, Plus, SunMedium } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusBadge, type Tone } from "@/components/ui/status-badge";
import { Segmented, Select } from "@/components/ui/field";
import { sizeOf } from "@/lib/diff";
import { fmtValue, LABEL, UNIT } from "@/lib/format";
import type { ComponentKey, DesignResponse, Locks, ValidationFlag } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ConfidenceRange } from "./confidence-range";
import { altLabel, cardReasons, otherSizes } from "./text";
import { INSTALLER, LOCK_KEY } from "./use-planner";

export const ICON = { pv: SunMedium, battery: BatteryMedium, wallbox: PlugZap, heatpump: Fan } as const;
export const TEXT_COLOR: Record<ComponentKey, string> = {
  pv: "text-comp-pv",
  battery: "text-comp-battery",
  wallbox: "text-comp-wallbox",
  heatpump: "text-comp-heatpump",
};
const MODULE_KWP = 0.45;

/** Counts up to a new value over 300 ms (instant with reduced motion). */
function useCountUp(target: number, decimals: number) {
  const [v, setV] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    const start = from.current;
    from.current = target;
    if (start === target || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setV(target);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / 300);
      const e = 1 - Math.pow(1 - p, 3);
      setV(Number((start + (target - start) * e).toFixed(decimals)));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, decimals]);
  return v;
}

function strip(r: string) {
  return r.replace(/^\[mock\]\s*/, "");
}

export interface CardStatus {
  tone: Tone;
  label: string;
  title?: string;
}

/** Status badge for a card: planner lock > validation > confidence. */
export function cardStatus(c: ComponentKey, r: DesignResponse, locks: Locks, flags: ValidationFlag[]): CardStatus {
  const locked = locks[LOCK_KEY[c]] !== null && locks[LOCK_KEY[c]] !== undefined;
  const d = r.design[c];
  if (c === "heatpump" && !d.include) {
    const opt = r.options?.heatpump;
    if (opt?.available) return { tone: "warning", label: "Customer option" };
    return { tone: "neutral", label: locked ? "Set by planner" : "Not needed" };
  }
  const physics = (r.physics.flags ?? []).find((f) => f.component === c && (f.level === "error" || f.level === "warn"));
  if (locked) {
    // a planner override is still validated against similar homes and physics: say so on the card (brief: "validation view")
    const unusual = flags.find((x) => x.component === c && x.level === "warn") ?? physics;
    return unusual ? { tone: "warning", label: "Set by planner · Unusual", title: unusual.message } : { tone: "neutral", label: "Set by planner" };
  }
  if (physics?.level === "error") return { tone: "critical", label: "Implausible", title: physics.message };
  const f = flags.find((x) => x.component === c && x.level !== "info");
  if (f?.level === "warn") return { tone: "warning", label: "Unusual", title: f.message };
  if (physics) return { tone: "warning", label: "Check", title: physics.message };
  if (f?.level === "ok") return { tone: "success", label: "Typical", title: f.message };
  if (d.confidence < 0.55) return { tone: "warning", label: "Low confidence", title: `${Math.round(d.confidence * 100)}% confidence` };
  return { tone: "success", label: d.confidence >= 0.75 ? "High confidence" : "Likely", title: `${Math.round(d.confidence * 100)}% confidence` };
}

export function SystemCard({
  component: c,
  response,
  locks,
  flags,
  changed,
  changeId,
  busy,
  onLock,
  before,
  highlighted = false,
  onHover,
}: {
  component: ComponentKey;
  response: DesignResponse;
  locks: Locks;
  flags: ValidationFlag[];
  changed: boolean;
  changeId: number;
  busy: boolean;
  onLock: (value: number | boolean | null, reason?: string | null) => void;
  /** Size before the last change (null: was not included); shown as "old → new" while the card is marked changed. */
  before?: number | null;
  /** The planner points at this part on the house. */
  highlighted?: boolean;
  /** Hover / focus on the card: highlight the part on the house (null on leave). */
  onHover?: (c: ComponentKey | null) => void;
}) {
  const d = response.design[c];
  const size = sizeOf(response.design, c);
  const lockedValue = locks[LOCK_KEY[c]];
  const locked = lockedValue !== null && lockedValue !== undefined;
  const status = cardStatus(c, response, locks, flags);
  const [editing, setEditing] = useState(false);
  const Icon = ICON[c];
  const decimals = c === "pv" ? 1 : 0;
  const shown = useCountUp(size ?? 0, decimals + 1);
  const hpOption = c === "heatpump" ? response.options?.heatpump : undefined;
  const range = "range" in d ? (d.range as [number, number]) : null;
  const peers =
    c === "pv"
      ? response.similar_homes.map((h) => h.pv_kwp).filter((x) => x > 0)
      : c === "battery"
        ? response.similar_homes.map((h) => h.battery_kwh ?? 0).filter((x) => x > 0)
        : [];
  const isOption = c === "heatpump" && !d.include && !!hpOption?.available;
  const { shown: reasons, more: moreReasons } = cardReasons(isOption ? hpOption!.reasons : d.reasons);
  const [showMore, setShowMore] = useState(false);
  const was = changed && before !== undefined ? before : undefined;
  // validation against similar homes (percentile) and physics, shown in full on the card, not only as a badge tooltip
  const checks = Array.from(
    new Set(
      [
        ...flags.filter((f) => f.component === c && (f.level === "warn" || f.level === "error")).map((f) => strip(f.message)),
        ...(response.physics.flags ?? []).filter((f) => f.component === c && (f.level === "warn" || f.level === "error")).map((f) => f.message),
      ],
    ),
  );

  return (
    <article
      id={`card-${c}`}
      className={cn(
        "relative flex scroll-mt-24 flex-col gap-3.5 rounded-md border p-5 transition-[border-color,box-shadow,background-color] duration-300",
        // the changed card keeps the highlight fill until the next change
        changed ? "border-highlight bg-[color-mix(in_srgb,var(--highlight)_16%,var(--surface-1))] shadow-[0_0_0_1px_var(--highlight)]" : "border-border bg-surface-1",
        highlighted && !changed && "border-border-strong shadow-[0_0_0_1px_var(--border-strong)]",
      )}
      aria-busy={busy}
      onMouseEnter={() => onHover?.(c)}
      onMouseLeave={() => onHover?.(null)}
      onFocus={() => onHover?.(c)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && onHover?.(null)}
    >
      <header className="flex items-center gap-2">
        <Icon className={cn("size-[18px] shrink-0", TEXT_COLOR[c])} strokeWidth={1.5} aria-hidden />
        <h2 className="flex-1 text-h3">{LABEL[c]}</h2>
        {!isOption && (
          <StatusBadge tone={status.tone} title={status.title}>
            {status.label}
          </StatusBadge>
        )}
      </header>

      <p className={cn("m-0 flex flex-wrap items-baseline gap-x-2 font-mono text-metric font-medium tabular", size == null && !isOption && "text-ink-muted")}>
        {was !== undefined && (
          <span className="text-[20px] font-normal text-ink-muted" aria-label={`was ${was == null ? "none" : `${fmtValue(c, was)} ${UNIT[c]}`}`}>
            <s className="decoration-1">{was == null ? "None" : fmtValue(c, was)}</s> →
          </span>
        )}
        {isOption ? (
          <span className="self-start rounded-pill bg-warning-tint px-3 py-1 font-sans text-[15px] leading-6 font-medium text-warning-text">
            Option · {fmtValue(c, hpOption!.kw)} {UNIT[c]}
          </span>
        ) : size == null ? (
          <>None</>
        ) : (
          <span>
            <span key={changeId} className={cn("-mx-1 px-1", changed && "animate-value-changed")}>
              {fmtValue(c, shown)}
            </span>{" "}
            <small className="text-[15px] text-ink-muted">{UNIT[c]}</small>
          </span>
        )}
      </p>

      {range && size != null && size > 0 && <ConfidenceRange component={c} value={size} range={range} peers={peers} />}

      {checks.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1 rounded-sm bg-warning-tint px-2.5 py-1.5 text-[12px] leading-4 text-warning-text" aria-label={`${LABEL[c]} checks`}>
          {checks.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      )}

      {reasons.length > 0 && (
        <ul className="m-0 flex list-disc flex-col gap-1 pl-[18px] text-[13px] leading-[19px] text-ink-body marker:text-ink-muted">
          {[...reasons, ...(showMore ? moreReasons : [])].map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      )}
      {moreReasons.length > 0 && (
        <button
          type="button"
          onClick={() => setShowMore((v) => !v)}
          aria-expanded={showMore}
          className="-mt-2 self-start cursor-pointer text-[12px] font-medium text-ink-muted underline decoration-border-strong underline-offset-4 hover:text-ink"
        >
          {showMore ? "Fewer reasons" : `${moreReasons.length} more ${moreReasons.length === 1 ? "reason" : "reasons"}`}
        </button>
      )}

      {editing ? (
        <Editor
          component={c}
          response={response}
          onCancel={() => setEditing(false)}
          onApply={(v, reason) => {
            setEditing(false);
            onLock(v, reason);
          }}
        />
      ) : (
        <footer className="mt-auto flex flex-wrap gap-2 pt-1">
          {isOption ? (
            <Button variant="secondary" size="sm" onClick={() => onLock(hpOption!.kw, "added the heat pump option")}>
              <Plus data-icon="inline-start" strokeWidth={1.5} />
              Include {fmtValue(c, hpOption!.kw)} kW heat pump
            </Button>
          ) : (
            <>
              <Button
                variant={locked ? "default" : "secondary"}
                size="sm"
                aria-pressed={locked}
                onClick={() => onLock(locked ? null : c === "wallbox" ? d.include : (size ?? 0))}
                aria-label={locked ? `Unlock ${LABEL[c]}` : `Lock ${LABEL[c]} at ${size == null ? "none" : `${fmtValue(c, size)} ${UNIT[c]}`}`}
              >
                {locked ? <Lock data-icon="inline-start" strokeWidth={1.5} /> : <LockOpen data-icon="inline-start" strokeWidth={1.5} />}
                {locked ? "Locked" : "Lock"}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
                Change
              </Button>
            </>
          )}
        </footer>
      )}
    </article>
  );
}

export function Editor({
  component: c,
  response,
  onApply,
  onCancel,
}: {
  component: ComponentKey;
  response: DesignResponse;
  onApply: (v: number | boolean, reason: string | null) => void;
  onCancel: () => void;
}) {
  const d = response.design;
  const current = sizeOf(d, c);
  const [reason, setReason] = useState("");
  const [pv, setPv] = useState(current ?? 0);
  const batterySizes = Array.from(
    new Set([0, ...(d.battery.alternatives ?? []).map((a) => a.kwh), ...(d.battery.range ?? []), ...(d.battery.kwh ? [d.battery.kwh] : [])]),
  )
    .filter((x) => x >= 0)
    .sort((a, b) => a - b);
  const [battery, setBattery] = useState(current ?? 0);
  // Every battery size this installer sells, so the planner can pick one the engine did not shortlist (e.g. 30 kWh).
  const [catalogue, setCatalogue] = useState<number[]>([]);
  useEffect(() => {
    if (c !== "battery") return;
    const ctrl = new AbortController();
    fetch(`/api/engine/catalogue?installer=${encodeURIComponent(INSTALLER)}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { battery_kwh?: number[] } | null) => setCatalogue(j?.battery_kwh ?? []))
      .catch(() => {});
    return () => ctrl.abort();
  }, [c]);
  const extraBattery = otherSizes(batterySizes, catalogue);
  const [wallbox, setWallbox] = useState(d.wallbox.include ? "yes" : "no");
  const [hp, setHp] = useState(current ?? 0);
  const hpKw = response.options?.heatpump?.available ? response.options.heatpump.kw : (d.heatpump.kw ?? 10);
  const reasonId = `reason-${c}`;

  const value = (): number | boolean => (c === "pv" ? pv : c === "battery" ? battery : c === "wallbox" ? wallbox === "yes" : hp);

  return (
    <form
      className="mt-auto flex flex-col gap-3 rounded-sm border border-border bg-surface-0 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        onApply(value(), reason.trim() || null);
      }}
      onKeyDown={(e) => e.key === "Escape" && onCancel()}
    >
      {c === "pv" && (
        <div className="flex items-center gap-2">
          <Button type="button" size="icon-sm" variant="secondary" aria-label="One panel less" onClick={() => setPv((v) => Math.max(0, +(v - MODULE_KWP).toFixed(2)))}>
            <Minus strokeWidth={1.5} />
          </Button>
          <output className="min-w-24 text-center font-mono text-[15px] font-medium tabular" aria-live="polite">
            {pv === 0 ? "No solar" : `${fmtValue("pv", pv)} kWp`}
            <span className="block text-[11px] font-normal text-ink-muted">{Math.round(pv / MODULE_KWP)} panels × 450 W</span>
          </output>
          <Button type="button" size="icon-sm" variant="secondary" aria-label="One panel more" onClick={() => setPv((v) => +(v + MODULE_KWP).toFixed(2))}>
            <Plus strokeWidth={1.5} />
          </Button>
        </div>
      )}
      {c === "pv" && (d.pv.alternatives ?? []).length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Other sizes the engine finds plausible">
          <span className="text-[12px] text-ink-muted">Also plausible:</span>
          {[...(d.pv.alternatives ?? [])]
            .sort((x, y) => x.kwp - y.kwp)
            .map((a) => {
              const t = altLabel(current ?? 0, a);
              return (
                <Button key={a.kwp} type="button" size="sm" title={t.title} variant={Math.abs(pv - a.kwp) < 1e-6 ? "default" : "secondary"} onClick={() => setPv(a.kwp)}>
                  {t.label}
                </Button>
              );
            })}
        </div>
      )}
      {c === "battery" && (
        <Segmented
          label="Battery size"
          value={battery}
          onChange={setBattery}
          options={batterySizes.map((s) => ({ value: s, label: s === 0 ? "None" : `${fmtValue("battery", s)} kWh` }))}
        />
      )}
      {c === "battery" && extraBattery.length > 0 && (
        <label className="flex items-center gap-2 text-[12px] text-ink-muted">
          Other size this installer sells
          <Select
            className="h-8 w-auto text-[13px]"
            value={extraBattery.includes(battery) ? String(battery) : ""}
            onChange={(e) => e.target.value && setBattery(Number(e.target.value))}
          >
            <option value="">Choose…</option>
            {extraBattery.map((s) => (
              <option key={s} value={s}>
                {fmtValue("battery", s)} kWh
              </option>
            ))}
          </Select>
        </label>
      )}
      {c === "wallbox" && (
        <Segmented
          label="Wallbox"
          value={wallbox}
          onChange={setWallbox}
          options={[
            { value: "no", label: "None" },
            { value: "yes", label: `${d.wallbox.kw ?? 11} kW wallbox` },
          ]}
        />
      )}
      {c === "heatpump" && (
        <Segmented
          label="Heat pump"
          value={hp}
          onChange={setHp}
          options={[
            { value: 0, label: "None" },
            { value: hpKw ?? 10, label: `${hpKw ?? 10} kW` },
          ]}
        />
      )}
      <label htmlFor={reasonId} className="sr-only">
        Why (optional)
      </label>
      <input
        id={reasonId}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Why? (optional, saved with the change)"
        className="h-8 rounded-sm border border-border bg-surface-1 px-2.5 text-[13px] outline-none placeholder:text-ink-muted focus-visible:border-focus focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-1 focus-visible:outline-focus/60"
      />
      <div className="flex gap-2">
        <Button type="submit" size="sm">
          Apply and lock
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
