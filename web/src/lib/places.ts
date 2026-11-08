/**
 * Address suggestions from Google Places Autocomplete (New), limited to Germany. SERVER ONLY (server key).
 * If the key may not call the Places API, the feature switches itself off for 10 minutes and the input just stays
 * a plain text field.
 */
import "server-only";
import { rankForHouseNumber, stripCountry } from "./address-rank";

export interface AddressSuggestion {
  text: string;
  main: string;
  secondary: string;
}

export interface AutocompleteReply {
  available: boolean;
  suggestions: AddressSuggestion[];
}

const OFF_MS = 10 * 60 * 1000;
let offUntil = 0;
const cache = new Map<string, AddressSuggestion[]>();

type Prediction = {
  text?: { text?: string };
  structuredFormat?: { mainText?: { text?: string }; secondaryText?: { text?: string } };
};

export async function autocompleteAddress(input: string, sessionToken?: string, fetchImpl: typeof fetch = fetch): Promise<AutocompleteReply> {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  const q = input.trim().slice(0, 120);
  if (!key || Date.now() < offUntil) return { available: false, suggestions: [] };
  if (!q) return { available: true, suggestions: [] };
  const hit = cache.get(q.toLowerCase());
  if (hit) return { available: true, suggestions: hit };
  try {
    const res = await fetchImpl("https://places.googleapis.com/v1/places:autocomplete", {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({ input: q, includedRegionCodes: ["de"], languageCode: "de", ...(sessionToken ? { sessionToken } : {}) }),
      signal: AbortSignal.timeout(4000),
    });
    if (res.status === 403 || res.status === 401) {
      offUntil = Date.now() + OFF_MS;
      console.warn("[places] the Google key may not call Places Autocomplete (New); suggestions are off");
      return { available: false, suggestions: [] };
    }
    if (!res.ok) return { available: true, suggestions: [] };
    const j = (await res.json()) as { suggestions?: { placePrediction?: Prediction }[] };
    const suggestions = (j.suggestions ?? [])
      .map((s) => s.placePrediction)
      .filter((p): p is Prediction => !!p?.text?.text)
      .slice(0, 6)
      .map((p) => ({ text: p.text!.text!, main: p.structuredFormat?.mainText?.text ?? p.text!.text!, secondary: p.structuredFormat?.secondaryText?.text ?? "" }));
    // never drop the typed house number (a street-only pick measures another building)
    // Germany only: the country suffix adds nothing and can move the geocode to another building
    const ranked = rankForHouseNumber(q, suggestions).map((x) => ({ ...x, text: stripCountry(x.text), secondary: stripCountry(x.secondary) }));
    if (cache.size > 500) cache.clear();
    cache.set(q.toLowerCase(), ranked);
    return { available: true, suggestions: ranked };
  } catch {
    return { available: true, suggestions: [] };
  }
}
