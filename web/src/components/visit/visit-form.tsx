"use client";

import { useId, useState } from "react";
import { Camera, MapPin, X } from "lucide-react";
import { AddressInput } from "@/components/ui/address-input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { canSubmit, EMPTY_VISIT, toVoiceFacts, type VisitForm as Form } from "./visit-logic";

export interface VisitSubmit {
  /** Keys of the voice pipeline (normaliseFacts); unanswered = null. */
  facts: Record<string, unknown>;
  floorplan: File | null;
}

const input =
  "h-12 w-full rounded-md border border-border bg-surface-1 px-3.5 text-[17px] text-ink outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-ink-muted focus-visible:border-focus focus-visible:shadow-[0_0_0_3px_color-mix(in_srgb,var(--focus)_22%,transparent)]";

/** A one-thumb segmented choice: equal columns, 44 px targets, tap again to clear. */
function Choice<T extends string | number>({
  label,
  value,
  onChange,
  options,
  cols,
}: {
  label: string;
  value: T | null;
  onChange: (v: T | null) => void;
  options: { value: T; label: string }[];
  cols?: number;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="grid gap-1 rounded-[14px] bg-surface-2 p-1"
      style={{ gridTemplateColumns: `repeat(${cols ?? options.length}, minmax(0, 1fr))` }}
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(on ? null : o.value)}
            className={cn(
              "min-h-11 cursor-pointer rounded-[10px] px-2 text-[15px] leading-5 font-medium transition-[background-color,color,box-shadow,transform] duration-150 ease-out active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus motion-reduce:active:scale-100",
              on ? "bg-surface-1 text-ink shadow-card" : "text-ink-body",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function Field({ label, hint, htmlFor, children }: { label: string; hint?: string; htmlFor?: string; children: React.ReactNode }) {
  const Tag = htmlFor ? "label" : "div";
  return (
    <div className="flex flex-col gap-2">
      <Tag {...(htmlFor ? { htmlFor } : {})} className="text-[15px] font-medium text-ink">
        {label}
      </Tag>
      {children}
      {hint && <p className="m-0 text-[13px] leading-[18px] text-ink-muted">{hint}</p>}
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-5 rounded-lg border border-border bg-surface-1 p-4">
      <h2 className="m-0 text-[12px] font-medium tracking-[0.06em] text-ink-muted uppercase">{title}</h2>
      {children}
    </section>
  );
}

/**
 * The installer's site-visit form, made for a phone held in one hand: only the address is required, every other
 * answer makes the design better. The parent sends `facts` through the voice pipeline's normalisation and the engine.
 */
export function VisitForm({ busy = false, error = null, onSubmit }: { busy?: boolean; error?: string | null; onSubmit: (v: VisitSubmit) => void }) {
  const [f, setF] = useState<Form>(EMPTY_VISIT);
  const [plan, setPlan] = useState<File | null>(null);
  const id = useId();
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  const ok = canSubmit(f);

  return (
    <form
      className="flex flex-col gap-4 pb-28"
      onSubmit={(e) => {
        e.preventDefault();
        if (ok && !busy) onSubmit({ facts: toVoiceFacts(f), floorplan: plan });
      }}
    >
      <header className="flex flex-col gap-1.5 px-1 pt-2">
        <p className="m-0 text-[13px] font-medium text-ink-muted">Site visit</p>
        <h1 className="m-0 text-[28px] leading-[1.1] font-normal tracking-[-0.02em] text-balance">The home, in two minutes</h1>
        <p className="m-0 text-[15px] leading-[21px] text-ink-body">Only the address is required.</p>
      </header>

      <Group title="The home">
        <Field label="Address" htmlFor={`${id}-addr`}>
          <div className="relative">
            <MapPin className="pointer-events-none absolute top-1/2 left-3.5 size-[18px] -translate-y-1/2 text-ink-muted" strokeWidth={1.5} aria-hidden />
            <AddressInput
              id={`${id}-addr`}
              className={cn(input, "pl-10")}
              value={f.address}
              onChange={(v) => set("address", v)}
              placeholder="Street and number, town"
              enterKeyHint="next"
              required
            />
          </div>
        </Field>
        <Field label="Customer name" htmlFor={`${id}-name`}>
          <input id={`${id}-name`} className={input} value={f.customer_name} onChange={(e) => set("customer_name", e.target.value)} placeholder="e.g. Weber" autoComplete="name" enterKeyHint="next" />
        </Field>
        <Field label="Solar already on the roof?">
          <Choice label="Solar already on the roof" value={f.existing_pv} onChange={(v) => set("existing_pv", v)} options={[{ value: "no", label: "No" }, { value: "yes", label: "Yes" }, { value: "unknown", label: "Don’t know" }]} />
        </Field>
        {f.existing_pv === "yes" && (
          <Field label="Its size (kWp)" htmlFor={`${id}-pvk`}>
            <input id={`${id}-pvk`} className={input} inputMode="decimal" value={f.existing_pv_kwp} onChange={(e) => set("existing_pv_kwp", e.target.value)} placeholder="e.g. 6.5" />
          </Field>
        )}
      </Group>

      <Group title="Electricity">
        <Field label="Yearly use or monthly bill">
          <Choice label="Enter yearly use or monthly bill" value={f.use_mode} onChange={(v) => set("use_mode", v ?? f.use_mode)} options={[{ value: "kwh", label: "kWh a year" }, { value: "bill", label: "€ a month" }]} />
          {f.use_mode === "kwh" ? (
            <input aria-label="Yearly use in kWh" className={input} inputMode="numeric" value={f.annual_kwh} onChange={(e) => set("annual_kwh", e.target.value)} placeholder="e.g. 4500" />
          ) : (
            <input aria-label="Monthly bill in euros" className={input} inputMode="decimal" value={f.monthly_bill_eur} onChange={(e) => set("monthly_bill_eur", e.target.value)} placeholder="e.g. 120" />
          )}
        </Field>
        <Field label="People in the home">
          <Choice label="People in the home" value={f.household} onChange={(v) => set("household", v)} options={[1, 2, 3, 4, 5].map((n) => ({ value: n, label: n === 5 ? "5+" : String(n) }))} />
        </Field>
        <Field label="Someone home in the daytime?">
          <Choice label="Someone home in the daytime" value={f.daytime} onChange={(v) => set("daytime", v)} options={[{ value: "yes", label: "Mostly" }, { value: "no", label: "Rarely" }]} />
        </Field>
      </Group>

      <Group title="Car and heating">
        <Field label="Electric car">
          <Choice label="Electric car" value={f.ev} onChange={(v) => set("ev", v)} options={[{ value: "no", label: "No" }, { value: "now", label: "Yes" }, { value: "planned", label: "Planned" }]} />
        </Field>
        {(f.ev === "now" || f.ev === "planned") && (
          <Field label="Kilometres a year" htmlFor={`${id}-km`}>
            <input id={`${id}-km`} className={input} inputMode="numeric" value={f.ev_km_year} onChange={(e) => set("ev_km_year", e.target.value)} placeholder="e.g. 15000" />
          </Field>
        )}
        <Field label="Heating today">
          <Choice
            label="Heating today"
            value={f.heating}
            onChange={(v) => set("heating", v)}
            cols={3}
            options={[
              { value: "gas", label: "Gas" },
              { value: "oil", label: "Oil" },
              { value: "heatpump", label: "Heat pump" },
              { value: "electric", label: "Electric" },
              { value: "district", label: "District" },
              { value: "wood", label: "Wood" },
            ]}
          />
        </Field>
        {f.heating && (
          <Field label="Age of the heating (years)" htmlFor={`${id}-age`}>
            <input id={`${id}-age`} className={input} inputMode="numeric" value={f.heating_age_years} onChange={(e) => set("heating_age_years", e.target.value)} placeholder="e.g. 15" />
          </Field>
        )}
      </Group>

      <Group title="Roof">
        <Field label="Covering">
          <Choice
            label="Roof covering"
            value={f.roof_type}
            onChange={(v) => set("roof_type", v)}
            cols={3}
            options={[
              { value: "concrete_tile", label: "Concrete tile" },
              { value: "clay_tile", label: "Clay tile" },
              { value: "slate", label: "Slate" },
              { value: "metal", label: "Metal" },
              { value: "flat", label: "Flat" },
              { value: "other", label: "Other" },
            ]}
          />
        </Field>
        <Field label="Main roof faces">
          <Choice
            label="Main roof direction"
            value={f.roof_direction ?? "auto"}
            onChange={(v) => set("roof_direction", v === "auto" || v === null ? null : v)}
            cols={4}
            options={[
              { value: "auto", label: "From address" },
              { value: "south", label: "South" },
              { value: "south_east", label: "SE" },
              { value: "south_west", label: "SW" },
              { value: "east", label: "East" },
              { value: "west", label: "West" },
              { value: "east_west", label: "East–west" },
              { value: "north", label: "North" },
            ]}
          />
        </Field>
      </Group>

      <Group title="Anything else">
        <Field label="Wishes" htmlFor={`${id}-wish`}>
          <textarea
            id={`${id}-wish`}
            rows={3}
            className={cn(input, "h-auto min-h-24 py-3 leading-6")}
            value={f.wishes}
            onChange={(e) => set("wishes", e.target.value)}
            placeholder="e.g. as independent as possible, no battery in the basement"
          />
        </Field>
        <Field label="Floor plan (optional)">
          {plan ? (
            <div className="flex h-12 items-center gap-2 rounded-md border border-border bg-surface-2 pr-1 pl-3.5 text-[15px]">
              <Camera className="size-[18px] shrink-0 text-ink-muted" strokeWidth={1.5} aria-hidden />
              <span className="min-w-0 flex-1 truncate">{plan.name}</span>
              <button type="button" onClick={() => setPlan(null)} aria-label="Remove the floor plan" className="grid size-10 cursor-pointer place-items-center rounded-full text-ink-muted hover:bg-surface-1 hover:text-ink">
                <X className="size-4" strokeWidth={1.75} />
              </button>
            </div>
          ) : (
            <label className="flex h-12 cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed border-border-strong text-[15px] font-medium text-ink-body transition-colors hover:bg-surface-2 has-focus-visible:outline-2 has-focus-visible:outline-focus">
              <Camera className="size-[18px]" strokeWidth={1.5} aria-hidden />
              Take or choose a photo
              <input type="file" accept="image/*,application/pdf" capture="environment" className="sr-only" onChange={(e) => setPlan(e.target.files?.[0] ?? null)} />
            </label>
          )}
        </Field>
      </Group>

      {/* the action sits where the thumb is: pinned to the bottom of the screen */}
      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-surface-0/90 px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))] backdrop-blur-md">
        <div className="mx-auto flex max-w-md flex-col gap-2">
          {error && (
            <p role="alert" className="m-0 text-[13px] text-critical-text">
              {error}
            </p>
          )}
          <Button type="submit" size="lg" disabled={!ok || busy} className="h-13 w-full text-[16px]">
            {busy ? "Building the design…" : ok ? "Build the design" : "Add the address to start"}
          </Button>
        </div>
      </div>
    </form>
  );
}
