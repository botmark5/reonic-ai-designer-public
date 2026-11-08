/** Planner display text: pure helpers, tested in text.test.ts. */
import { fmtKwp } from "@/lib/format";

const norm = (clause: string) => clause.trim().replace(/[.\s]+$/, "").toLowerCase();

/**
 * Engine reasons as the card shows them: "[mock]" tag removed, clauses repeated within or across reasons dropped
 * (the engine can say "the installer's catalogue speaks for 10 kWh" three times), at most `max` shown by default.
 */
export function cardReasons(reasons: string[], max = 2): { shown: string[]; more: string[] } {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of reasons) {
    const text = raw.replace(/^\[mock\]\s*/, "").trim();
    if (!text) continue;
    const kept = text.split(/;\s+/).filter((c) => {
      const k = norm(c);
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    if (!kept.length) continue;
    let joined = kept.map((c) => c.trim()).join("; ");
    if (/[.!?]$/.test(text) && !/[.!?]$/.test(joined)) joined += ".";
    out.push(joined);
  }
  return { shown: out.slice(0, max), more: out.slice(max) };
}

/** Header and inbox title: the call's name, else its address; "Unnamed home" only for a blank manual home. */
export function homeTitle(row: { customer_name: string | null; address: string | null; source: string }): string {
  const name = row.customer_name?.trim();
  if (name) return name;
  const address = row.address?.trim();
  if (address) return address;
  return row.source === "voice" ? "Draft from a call" : "Unnamed home";
}

/** "Also plausible" chips: "Smaller 6.3 kWp" / "Larger 11.7 kWp" relative to the proposal; the share goes in the tooltip. */
export function altLabel(proposed: number, alt: { kwp: number; share?: number | null }): { label: string; title: string | undefined } {
  const word = alt.kwp < proposed ? "Smaller" : "Larger";
  return {
    label: `${word} ${fmtKwp(alt.kwp)} kWp`,
    title: typeof alt.share === "number" ? `${Math.round(alt.share * 100)} % of similar homes got this size` : undefined,
  };
}

/** Catalogue sizes the installer sells that the size buttons don't already offer (ascending; zero, negatives and NaN dropped). */
export function otherSizes(shown: number[], catalogue: number[] | undefined): number[] {
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-3;
  return [...new Set(catalogue ?? [])]
    .filter((s) => Number.isFinite(s) && s > 0 && !shown.some((x) => near(x, s)))
    .sort((a, b) => a - b);
}
