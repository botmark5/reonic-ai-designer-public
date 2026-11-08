import { fmtValue, UNIT } from "@/lib/format";
import type { ComponentKey } from "@/lib/types";
import { cn } from "@/lib/utils";

const BAND: Record<ComponentKey, string> = {
  pv: "bg-comp-pv",
  battery: "bg-comp-battery",
  wallbox: "bg-comp-wallbox",
  heatpump: "bg-comp-heatpump",
};

function niceDomain(lo: number, hi: number): [number, number, number] {
  const span = Math.max(hi - lo, 1);
  const step = span <= 6 ? 2 : span <= 12 ? 3 : span <= 24 ? 5 : 10;
  const a = Math.max(0, Math.floor(lo / step) * step);
  const b = Math.ceil(hi / step) * step;
  return [a, b === a ? a + step : b, step];
}

/**
 * Where the proposed size sits among similar homes: the band is the engine's typical range,
 * dots are the nearest similar homes, the bar is our proposal.
 */
export function ConfidenceRange({
  component,
  value,
  range,
  peers = [],
}: {
  component: ComponentKey;
  value: number;
  range: [number, number];
  peers?: number[];
}) {
  const all = [value, ...range, ...peers].filter((x) => Number.isFinite(x));
  const [min, max, step] = niceDomain(Math.min(...all) * 0.85, Math.max(...all) * 1.1);
  const pos = (x: number) => `${((x - min) / (max - min)) * 100}%`;
  const ticks: number[] = [];
  for (let t = min; t <= max + 1e-9; t += step) ticks.push(t);
  const unit = UNIT[component];
  const [lo, hi] = range;

  return (
    <figure
      className="m-0"
      aria-label={`${fmtValue(component, value)} ${unit}; similar homes typically ${fmtValue(component, lo)} to ${fmtValue(component, hi)} ${unit}`}
    >
      <div className="relative h-2 rounded-sm bg-surface-2">
        <div
          className={cn("absolute inset-y-0 rounded-sm opacity-35", BAND[component])}
          style={{ left: pos(lo), width: `calc(${pos(hi)} - ${pos(lo)})`, minWidth: 4 }}
        />
        {peers.map((p, i) => (
          <span
            key={i}
            className="absolute top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-ink-muted/60"
            style={{ left: pos(p) }}
            aria-hidden
          />
        ))}
        <span
          className="absolute -top-1 h-4 w-1 -translate-x-1/2 rounded-[2px] bg-ink transition-[left] duration-300 ease-out motion-reduce:transition-none"
          style={{ left: pos(value) }}
          aria-hidden
        />
      </div>
      <figcaption className="mt-1.5 flex justify-between font-mono text-[11px] leading-[14px] text-ink-muted tabular" aria-hidden>
        {ticks.map((t, i) => (
          <span key={t}>
            {fmtValue(component, t).replace(/\.0$/, "")}
            {i === ticks.length - 1 ? ` ${unit}` : ""}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}
