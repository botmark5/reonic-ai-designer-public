/**
 * Address suggestions must keep the house number the planner typed: "Musterstraße 80" must never turn into the
 * street alone ("Musterstraße, 80939 München"), because Google Solar would then measure a different building.
 */
export interface Suggestion {
  text: string;
  main: string;
  secondary: string;
}

/** House number typed after the street in the first part of the address ("80", "80a", "59 a"); null if none. */
export function typedHouseNumber(input: string): string | null {
  const street = input.split(",")[0].trim();
  const m = street.match(/^(.*?[A-Za-zÄÖÜäöüß.])\s+(\d{1,4}(?:\s?[a-zA-Z])?)$/);
  return m ? m[2] : null;
}

const hasNumber = (main: string, n: string) => new RegExp(`(^|\\s)${n.replace(/\s+/g, "\\s?")}(\\b|$)`, "i").test(main);

/**
 * With a typed number: only suggestions that carry it. If Google has none (it knows only the street), the street
 * suggestions get the typed number inserted, so picking one still geocodes the right building.
 */
export function rankForHouseNumber(input: string, list: Suggestion[]): Suggestion[] {
  const n = typedHouseNumber(input);
  if (!n) return list;
  const exact = list.filter((x) => hasNumber(x.main, n));
  if (exact.length) return exact;
  return list
    .filter((x) => !/\d/.test(x.main))
    .map((x) => {
      const main = `${x.main} ${n}`;
      return { main, secondary: x.secondary, text: x.text.startsWith(x.main) ? main + x.text.slice(x.main.length) : `${main}, ${x.secondary}` };
    });
}

/** "Musterstraße 80, München, Deutschland" → "Musterstraße 80, München" (suggestions are Germany-only). */
export const stripCountry = (t: string) => t.replace(/,\s*(Deutschland|Germany)\s*$/i, "");
