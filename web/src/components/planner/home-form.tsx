"use client";

import { useId, useState } from "react";
import { controlClass, Field, Segmented, Select, TextInput } from "@/components/ui/field";
import { AddressInput } from "@/components/ui/address-input";
import { compass } from "@/lib/roof";
import type { Home } from "@/lib/types";
import { Button } from "@/components/ui/button";

export type AddressLookup = "idle" | "looking" | "found" | "noroof" | "notfound";

/** The customer's address: "Find house" saves it and looks the roof up (Google Solar → roof inputs, 3D house, Sun map). */
function AddressField({ address, lookup, roofKwp, onFind }: { address: string; lookup: AddressLookup; roofKwp: number | null; onFind: (a: string) => void }) {
  const [draft, setDraft] = useState(address);
  const id = useId();
  const status =
    lookup === "looking"
      ? "Looking up the house…"
      : lookup === "found"
        ? `✓ House found${roofKwp ? ` · roof fits about ${roofKwp} kWp` : ""}`
        : lookup === "noroof"
          ? "✓ Address found · no roof model from Google here"
          : lookup === "notfound"
            ? "Address not found. Try street + number + city."
          : "The roof size, the real house and the sun map come from the address.";
  return (
    <form
      className="flex flex-col gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        if (draft.trim()) onFind(draft.trim());
      }}
    >
      <label htmlFor={id} className="text-label text-ink-muted">
        Address
      </label>
      <div className="flex gap-2">
        <AddressInput
          id={id}
          value={draft}
          onChange={setDraft}
          onPick={(a) => onFind(a)}
          placeholder="Street, number, city"
          className={controlClass}
        />
        <Button type="submit" variant="secondary" disabled={!draft.trim() || lookup === "looking"} className="shrink-0">
          {lookup === "looking" ? "Finding…" : "Find house"}
        </Button>
      </div>
      <p role="status" className={`m-0 text-[12px] leading-4 ${lookup === "notfound" ? "font-medium text-warning-text" : lookup === "found" || lookup === "noroof" ? "font-medium text-ink" : "text-ink-muted"}`}>
        {status}
      </p>
    </form>
  );
}

const HEATING = ["Gas", "Oil", "Heat pump", "Electric", "District", "Wood"] as const;
const ROOF = ["Concrete tile", "Clay tile", "Metal", "Flat", "Slate"] as const;

const parseNum = (s: string) => {
  const n = Number(s.replace(/[\s,]/g, "").replace(/€|kwh|km/gi, ""));
  return s.trim() === "" || !Number.isFinite(n) ? null : n;
};
const show = (n: number | null | undefined) => (n == null ? "" : n.toLocaleString("en-US"));

/** Number input that commits on blur / Enter (not on every keystroke), so each commit is one engine run. */
function NumberField({
  label,
  value,
  onCommit,
  hint,
  min = 0,
  max,
  step,
  required,
}: {
  label: string;
  value: number | null;
  onCommit: (v: number | null) => void;
  hint?: string;
  min?: number;
  max?: number;
  step?: number;
  required?: boolean;
}) {
  const id = useId();
  const [draft, setDraft] = useState(show(value));
  const [error, setError] = useState<string | null>(null);
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setDraft(show(value));
  }
  const commit = () => {
    const n = parseNum(draft);
    if (n == null && required) return setError("Needed for a design.");
    if (n != null && (n < min || (max != null && n > max))) return setError(`Between ${show(min)} and ${show(max ?? null)}.`);
    setError(null);
    if (n !== value) onCommit(n == null ? null : step ? Math.round(n / step) * step : n);
    setDraft(show(n));
  };
  return (
    <Field label={label} htmlFor={id} hint={error ? <span className="text-critical-text">{error}</span> : hint}>
      <TextInput
        id={id}
        inputMode="decimal"
        value={draft}
        aria-invalid={!!error}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
      />
    </Field>
  );
}

export function HomeForm({
  home,
  onChange,
  address,
  lookup = "idle",
  onFindHouse,
}: {
  home: Home;
  onChange: (patch: Partial<Home>) => void;
  address?: string;
  lookup?: AddressLookup;
  onFindHouse?: (address: string) => void;
}) {
  const roofSet = home.roof_max_kwp != null || home.roof_azimuth != null || home.roof_pitch != null;
  const id = useId();
  return (
    <section aria-labelledby={`${id}-t`} className="flex flex-col gap-3 rounded-md border border-border bg-surface-1 p-4">
      <h2 id={`${id}-t`} className="text-label uppercase text-ink-muted">
        The home
      </h2>
      {onFindHouse && <AddressField address={address ?? ""} lookup={lookup} roofKwp={home.roof_max_kwp ?? null} onFind={onFindHouse} />}
      <div className="flex flex-col gap-1">
        <span className="text-label text-ink-muted">Solar already on the roof?</span>
        <Segmented
          label="Solar already on the roof?"
          value={home.has_existing_pv == null ? "unknown" : home.has_existing_pv ? "yes" : "no"}
          onChange={(v) =>
            onChange(v === "yes" ? { has_existing_pv: true } : { has_existing_pv: v === "unknown" ? null : false, existing_pv_kwp: null })
          }
          options={[
            { value: "no", label: "No" },
            { value: "yes", label: "Yes" },
            { value: "unknown", label: "Don't know" },
          ]}
          className="self-start"
        />
        <p className="m-0 text-[12px] leading-4 text-ink-muted">Changes the design the most: new system or battery add-on.</p>
      </div>
      {home.has_existing_pv === true && (
        <NumberField
          label="Existing solar (kWp, optional)"
          value={home.existing_pv_kwp}
          max={100}
          onCommit={(v) => onChange({ existing_pv_kwp: v })}
        />
      )}
      <NumberField
        label="Annual consumption (kWh)"
        value={home.annual_kwh}
        required
        max={100000}
        hint={home.annual_kwh === 4500 ? "4,500 is Reonic's default: confirm the real figure." : undefined}
        onCommit={(v) => onChange({ annual_kwh: v ?? 0, demand_is_default: false })}
      />
      <NumberField label="Electricity price (€/kWh)" value={home.price_eur_kwh} max={2} onCommit={(v) => onChange({ price_eur_kwh: v })} />
      <Field label="Household" htmlFor={`${id}-hh`}>
        <Select
          id={`${id}-hh`}
          value={home.inhabitants ?? ""}
          onChange={(e) => onChange({ inhabitants: e.target.value ? Number(e.target.value) : null })}
        >
          <option value="">Not asked yet</option>
          {[1, 2, 3, 4, 5, 6].map((n) => (
            <option key={n} value={n}>
              {n === 1 ? "1 person" : `${n} people`}
            </option>
          ))}
        </Select>
      </Field>
      <div className="flex flex-col gap-1">
        <span className="text-label text-ink-muted" id={`${id}-ev`}>
          Electric car
        </span>
        <Segmented
          label="Electric car"
          value={home.has_ev ? "yes" : "no"}
          onChange={(v) => onChange(v === "yes" ? { has_ev: true, ev_km_year: home.ev_km_year ?? 15000 } : { has_ev: false })}
          options={[
            { value: "no", label: "No" },
            { value: "yes", label: "Yes" },
          ]}
          className="self-start"
        />
      </div>
      {home.has_ev && (
        <NumberField label="Car: km per year" value={home.ev_km_year} max={100000} step={500} onCommit={(v) => onChange({ ev_km_year: v })} />
      )}
      <Field label="Heating" htmlFor={`${id}-heat`}>
        <Select id={`${id}-heat`} value={home.heating ?? ""} onChange={(e) => onChange({ heating: e.target.value || null })}>
          <option value="">Unknown</option>
          {HEATING.map((h) => (
            <option key={h}>{h}</option>
          ))}
        </Select>
      </Field>
      {(home.heating === "Gas" || home.heating === "Oil") && (
        <NumberField
          label="Heating demand (kWh / year)"
          value={home.heating_demand_kwh}
          max={200000}
          hint="Yearly gas or oil use. Sizes the heat pump option."
          onCommit={(v) => onChange({ heating_demand_kwh: v })}
        />
      )}
      <Field label="Roof" htmlFor={`${id}-roof`}>
        <Select id={`${id}-roof`} value={home.roof_type ?? ""} onChange={(e) => onChange({ roof_type: e.target.value || null })}>
          <option value="">Unknown</option>
          {ROOF.map((r) => (
            <option key={r}>{r}</option>
          ))}
        </Select>
      </Field>
      <details className="group" open={roofSet || undefined}>
        <summary className="cursor-pointer list-none text-[13px] font-medium text-ink-body hover:text-ink">
          <span className="inline-block transition-transform duration-150 group-open:rotate-90" aria-hidden>
            ›
          </span>{" "}
          Roof size and direction
          {roofSet ? <span className="ml-1 text-ink-muted">· {home.roof_max_kwp ? `fits ${home.roof_max_kwp} kWp` : "set"}</span> : null}
        </summary>
        <div className="mt-3 flex flex-col gap-3">
          <p className="m-0 text-[12px] leading-4 text-ink-muted">
            Filled from Google Solar when the address is known. The limit caps the solar size; direction and pitch change the yield, not the size.
          </p>
          <NumberField
            label="Roof fits up to (kWp)"
            value={home.roof_max_kwp ?? null}
            min={0.5}
            max={200}
            onCommit={(v) => onChange({ roof_max_kwp: v })}
          />
          <div className="grid grid-cols-2 gap-3">
            <NumberField
              label="Faces (° from north)"
              value={home.roof_azimuth ?? null}
              max={360}
              step={1}
              hint={compass(home.roof_azimuth) ? `${compass(home.roof_azimuth)}; 180 = south` : "180 = south"}
              onCommit={(v) => onChange({ roof_azimuth: v })}
            />
            <NumberField label="Pitch (°)" value={home.roof_pitch ?? null} max={90} step={1} onCommit={(v) => onChange({ roof_pitch: v })} />
          </div>
          {roofSet && (
            <button
              type="button"
              onClick={() => onChange({ roof_max_kwp: null, roof_azimuth: null, roof_pitch: null })}
              className="self-start cursor-pointer text-[13px] font-medium text-ink-body underline decoration-border-strong underline-offset-4 hover:text-ink"
            >
              Ignore roof data
            </button>
          )}
        </div>
      </details>
      <details className="group">
        <summary className="cursor-pointer list-none text-[13px] font-medium text-ink-body hover:text-ink">
          <span className="inline-block transition-transform duration-150 group-open:rotate-90" aria-hidden>
            ›
          </span>{" "}
          Battery already installed
          {home.existing_battery_kwh ? <span className="ml-1 text-ink-muted">· set</span> : null}
        </summary>
        <div className="mt-3 flex flex-col gap-3">
          <NumberField label="Existing battery (kWh)" value={home.existing_battery_kwh} max={100} onCommit={(v) => onChange({ existing_battery_kwh: v })} />
        </div>
      </details>
    </section>
  );
}
