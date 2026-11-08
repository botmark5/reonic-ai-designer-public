"""
engine/llm.py - the ONLY place Claude is used, and never to pick component sizes (CLAUDE.md hard rule).

    refine(text, home)        planner text -> structured input changes / locks   (Claude Haiku 5.5, structured output)
    explain_stream(response)  engine facts -> plain-language explanation         (Claude Sonnet 5.5, streamed)

Both work without an API key: a keyword parser and a template explanation take over, so the demo never breaks.
The key is read from ANTHROPIC_API_KEY or engine/.env (gitignored).
"""
from __future__ import annotations

import json
import logging
import os
import re
from pathlib import Path
from typing import Iterator, Literal, Optional

from pydantic import BaseModel, Field

log = logging.getLogger("engine.llm")
ENV_FILE = Path(__file__).resolve().parent / ".env"
REFINE_MODEL = "claude-haiku-5-5"       # PLAN.md: refine box = Haiku
EXPLAIN_MODEL = "claude-sonnet-5-5"     # PLAN.md: streamed explanation = Sonnet

try:
    from dotenv import load_dotenv
    load_dotenv(ENV_FILE)
except ImportError:                     # python-dotenv is in requirements, but stay importable without it
    pass


def claude_available() -> bool:
    return bool(os.environ.get("ANTHROPIC_API_KEY"))


def _client():
    import anthropic
    return anthropic.Anthropic()


# ---------------------------------------------------------------------------
# /refine: planner text -> changes
# ---------------------------------------------------------------------------
LoadProfile = Literal["H0", "FamilyOfFour", "HomeOfficeOnePerson", "FullTimeOnePerson", "PartTimeOnePerson",
                      "SeniorOnePerson", "SingleParentThreePersons"]
Heating = Literal["Gas", "Oil", "Heatpump", "OtherNonRenewable", "OtherRenewable"]


class HomeChanges(BaseModel):
    """Facts about the home that the note changes. null = not mentioned."""
    annual_kwh: Optional[float] = Field(description="new yearly household electricity demand in kWh")
    has_ev: Optional[bool] = Field(description="true if the household has or will get an electric car")
    ev_km_year: Optional[float] = Field(description="yearly driving distance of the EV in km, only if stated")
    heating: Optional[Heating] = Field(description="the home's EXISTING heating system, only if the note changes it")
    heating_demand_kwh: Optional[float] = Field(description="yearly heat demand in kWh, only if stated")
    load_profile: Optional[LoadProfile] = Field(description="household type / daytime presence, only if implied")
    price_eur_kwh: Optional[float] = Field(description="electricity price in EUR per kWh, only if stated")
    has_existing_pv: Optional[bool] = Field(description="true if PV is ALREADY on the roof, false if there is none yet")


class LockChanges(BaseModel):
    """Components the planner explicitly fixes. null = not mentioned. 0 means 'none of this component'."""
    pv_kwp: Optional[float] = Field(description="PV size in kWp the planner fixes; 0 = no PV")
    battery_kwh: Optional[float] = Field(description="battery size in kWh the planner fixes; 0 = no battery")
    wallbox: Optional[bool] = Field(description="true/false if the planner explicitly wants / does not want a wallbox")
    heatpump_kw: Optional[float] = Field(description="heat pump size in kW, ONLY if the note states a size; 0 = no heat pump")
    want_heatpump: Optional[bool] = Field(description="true if the customer wants a heat pump (size chosen by the engine), "
                                                      "false if they do not want one")


class RefineResult(BaseModel):
    home_changes: HomeChanges
    lock_changes: LockChanges
    summary: str = Field(description="one short sentence: what changed, in plain words")


REFINE_SYSTEM = """You turn a solar installer planner's short note about a home into structured changes for a design engine.
Rules:
- Only fill fields the note states or clearly implies. Everything else is null.
- home_changes are facts about the household (consumption, electric car, heating, household type).
- lock_changes are ONLY for components the planner explicitly fixes or removes ("make it 10 kWp", "no battery").
- A heat pump is an option the customer chooses: "they want a heat pump" -> want_heatpump = true;
  "no heat pump" -> want_heatpump = false. Only set heatpump_kw if a size in kW is stated.
  Never invent a component size yourself; the engine sizes everything that is not locked.
- "buying an electric car" / "getting an EV next year" -> has_ev = true (leave ev_km_year null unless a distance is given).
- load_profile only when the note explicitly describes who lives there or who is home during the day
  ("works from home" -> HomeOfficeOnePerson, "a couple with two children" -> FamilyOfFour). The words
  "the family" or "the customer" alone do NOT change the load profile.
- "they already have solar panels" -> has_existing_pv = true; "no PV on the roof yet" -> has_existing_pv = false.
- Numbers: convert MWh to kWh; ignore currencies other than EUR."""


def refine(text: str, home: dict | None = None) -> dict:
    """Returns {"home_changes": {...}, "lock_changes": {...}, "summary": str, "source": "claude" | "rules"}."""
    if claude_available():
        try:
            import anthropic
            response = _client().messages.parse(
                model=REFINE_MODEL,
                max_tokens=4096,
                system=REFINE_SYSTEM,
                messages=[{"role": "user", "content":
                           f"Current home (for context, do not repeat unchanged values):\n{json.dumps(home or {}, default=str)}"
                           f"\n\nPlanner note:\n{text}"}],
                output_format=RefineResult,
            )
            if response.stop_reason == "refusal" or response.parsed_output is None:
                log.warning("refine: Claude returned no usable output (%s), using rules", response.stop_reason)
            else:
                r = response.parsed_output
                return dict(home_changes=_drop_none(r.home_changes.model_dump()),
                            lock_changes=_drop_none(r.lock_changes.model_dump()), summary=r.summary, source="claude")
        except anthropic.RateLimitError:
            log.warning("refine: rate limited, using rules")
        except anthropic.APIStatusError as e:
            log.warning("refine: API error %s, using rules", e.status_code)
        except anthropic.APIConnectionError:
            log.warning("refine: no connection to the API, using rules")
    return rule_refine(text)


def _drop_none(d: dict) -> dict:
    return {k: v for k, v in d.items() if v is not None}


_NUM = r"(\d+(?:[.,]\d+)?)"


def _f(s: str) -> float:
    return float(s.replace(",", "."))


def rule_refine(text: str) -> dict:
    """Keyword fallback (English + German) when Claude is unavailable. Deliberately simple and predictable."""
    t = text.lower()
    home, locks, said = {}, {}, []
    if re.search(r"\b(ev|e-?auto|electric (car|vehicle)|elektroauto|tesla)\b", t):
        if re.search(r"\b(no|sold|without|kein|ohne)\b[^.]*\b(ev|e-?auto|electric car|elektroauto)", t):
            home["has_ev"] = False
            said.append("no electric car")
        else:
            home["has_ev"] = True
            said.append("electric car added")
            # "15,000 km" / "15.000 km" (thousands separator) or "15k km"
            m = re.search(r"(\d{1,3}(?:[.,]\d{3})+|\d+(?:[.,]\d+)?)\s*(k|tsd\.?|thousand)?\s*km", t)
            if m:
                raw = m.group(1)
                num = float(re.sub(r"[.,]", "", raw)) if re.fullmatch(r"\d{1,3}(?:[.,]\d{3})+", raw) else _f(raw)
                km = num * (1000 if m.group(2) else 1)
                home["ev_km_year"] = km
                said.append(f"{km:,.0f} km/year")
    m = re.search(_NUM + r"\s*(mwh|kwh)\s*(per year|/year|a year|im jahr|pro jahr|consumption|verbrauch)", t) or \
        re.search(r"(consumption|verbrauch|uses)\D{0,20}" + _NUM + r"\s*(mwh|kwh)", t)
    if m:
        g = m.groups()
        val, unit = (_f(g[0]), g[1]) if g[0] and g[0][0].isdigit() else (_f(g[1]), g[2])
        home["annual_kwh"] = val * (1000 if unit == "mwh" else 1)
        said.append(f"demand {home['annual_kwh']:,.0f} kWh")
    if re.search(r"(no|kein|ohne|not)\s+(pv|solar|photovoltaik)[^.]*(yet|bisher|noch)|no (pv|solar panels) on the roof", t):
        home["has_existing_pv"] = False
        said.append("no PV on the roof yet")
    elif re.search(r"(already|existing|bestehende|vorhandene|hat schon|haben schon)\s+(has\s+|have\s+)?(a\s+)?(pv|solar|photovoltaik)", t):
        home["has_existing_pv"] = True
        said.append("PV already on the roof")
    if re.search(r"home ?office|work(s|ing)? from home", t):
        home["load_profile"] = "HomeOfficeOnePerson"
        said.append("home office")
    if re.search(r"\b(gas|erdgas)\b", t) and re.search(r"heat|heiz", t):
        home["heating"] = "Gas"
    if re.search(r"\b(oil|öl|heizöl)\b", t):
        home["heating"] = "Oil"
    if re.search(r"(no|without|kein|ohne)\s+(battery|speicher|batterie)", t):
        locks["battery_kwh"] = 0.0
        said.append("no battery")
    elif m := re.search(_NUM + r"\s*kwh\s*(battery|speicher|batterie)|(battery|speicher|batterie)\D{0,15}" + _NUM + r"\s*kwh", t):
        v = m.group(1) or m.group(4)
        locks["battery_kwh"] = _f(v)
        said.append(f"battery fixed at {v} kWh")
    no_hp = re.search(r"(no|without|kein|ohne|don't want|doesn't want|not)\s+(a\s+)?(heat ?pump|wärmepumpe)", t)
    if not no_hp and re.search(r"\b(add|with|wants?|include|mit|plus)\b[^.]*(heat ?pump|wärmepumpe)", t):
        locks["want_heatpump"] = True
        said.append("heat pump wanted")
    if re.search(r"(no|without|kein|ohne)\s+(heat ?pump|wärmepumpe)", t):
        locks["heatpump_kw"] = 0.0
        said.append("no heat pump")
    if re.search(r"(no|without|kein|ohne)\s+wallbox", t):
        locks["wallbox"] = False
        said.append("no wallbox")
    elif re.search(r"\b(add|with|want|mit)\b[^.]*wallbox", t):
        locks["wallbox"] = True
        said.append("wallbox wanted")
    if m := re.search(_NUM + r"\s*kwp", t):
        locks["pv_kwp"] = _f(m.group(1))
        said.append(f"PV fixed at {m.group(1)} kWp")
    summary = ("Understood: " + ", ".join(said) + ".") if said else "No change recognised; please rephrase."
    return dict(home_changes=home, lock_changes=locks, summary=summary, source="rules")


# ---------------------------------------------------------------------------
# /explain: engine facts -> plain language (streamed)
# ---------------------------------------------------------------------------
EXPLAIN_SYSTEM = {
    "planner": """You explain a home energy design proposed by an engine to an installer's planner.
Use ONLY the facts in the JSON. Never change, add or recommend component sizes that are not in it
(alternatives listed in the JSON may be mentioned as alternatives). Be concise: at most 7 short bullet points,
one per component plus physics/economics, plus the heat pump option (options.heatpump) if one is offered. Mention confidence and anything flagged as unusual. No preamble.""",
    "homeowner": """You explain an energy system offer to a homeowner with no technical background.
Use ONLY the facts in the JSON. Never change, add or recommend component sizes that are not in it.
Plain words, no jargon (say "share of your electricity from your own roof" instead of "autarky").
At most 150 words: what they get, why it fits their home, what it saves, and one honest caveat. If a heat pump
is offered as an option (options.heatpump), explain the choice neutrally with its extra cost and savings. No preamble.""",
}


def explain_stream(design_response: dict, audience: str = "planner", language: str = "en") -> Iterator[str]:
    """Yield explanation text chunks. Falls back to a template when Claude is unavailable or declines."""
    audience = audience if audience in EXPLAIN_SYSTEM else "planner"
    if claude_available():
        import anthropic
        sent = False
        try:
            # server-side fallback: if the model declines, the API re-runs the request on a fallback model
            with _client().beta.messages.stream(
                model=EXPLAIN_MODEL,
                max_tokens=16000,
                betas=["server-side-fallback-2026-07-01"],
                fallbacks="default",
                output_config={"effort": "low"},
                system=EXPLAIN_SYSTEM[audience] + ("\nAnswer in German." if language == "de" else ""),
                messages=[{"role": "user", "content": json.dumps(_facts(design_response), default=str)}],
            ) as stream:
                for text in stream.text_stream:
                    sent = True
                    yield text
                final = stream.get_final_message()
            if final.stop_reason == "refusal" and not sent:
                log.warning("explain: declined, using template")
            elif sent:
                return
        except anthropic.RateLimitError:
            log.warning("explain: rate limited, using template")
        except anthropic.APIStatusError as e:
            log.warning("explain: API error %s, using template", e.status_code)
        except anthropic.APIConnectionError:
            log.warning("explain: no connection, using template")
        if sent:            # stream broke mid-way: finish the sentence honestly instead of restarting
            yield "\n\n(Explanation interrupted; the design numbers above are complete.)"
            return
    yield template_explanation(design_response, audience)


def _facts(resp: dict) -> dict:
    """Only what the explanation needs (keeps the prompt small and free of internals)."""
    keys = ("design", "physics", "economics", "options", "facts_for_explanation", "warnings")
    return {k: resp[k] for k in keys if k in resp}


def template_explanation(resp: dict, audience: str = "planner") -> str:
    """Deterministic explanation from engine facts (no LLM)."""
    d, ph = resp.get("design", {}), resp.get("physics", {})
    eco = resp.get("economics", {})
    lines = []
    for comp, label, unit, key in [("pv", "PV", "kWp", "kwp"), ("battery", "Battery", "kWh", "kwh"),
                                   ("heatpump", "Heat pump", "kW", "kw"), ("wallbox", "Wallbox", "kW", "kw")]:
        c = d.get(comp)
        if not c:
            continue
        head = f"{label}: {c[key]:g} {unit}" if c.get("include") and c.get(key) else f"{label}: {'yes' if c.get('include') else 'none'}"
        reason = c.get("reasons", [""])[0]
        lines.append(f"- {head}. {reason}")
    if ph:
        lines.append(f"- Physics: about {ph.get('yield_kwh', 0):,.0f} kWh solar per year; "
                     f"{ph.get('autarky', 0):.0%} of the home's electricity would come from its own roof "
                     f"({ph.get('self_consumption', 0):.0%} of the solar power used at home).")
    if eco.get("payback_years"):
        lines.append(f"- Economics (placeholder prices): about {eco['savings_first_year_eur']:,.0f} EUR saved in the first year, "
                     f"payback after about {eco['payback_years']:.0f} years.")
    hp = resp.get("options", {}).get("heatpump", {})
    if hp.get("available") and not hp.get("included"):
        diff = hp["difference"]
        lines.append(f"- Option: a {hp['kw']:g} kW heat pump instead of the current heating would cost about "
                     f"{diff['extra_investment_eur']:,.0f} EUR more and change yearly savings by "
                     f"{diff['extra_savings_per_year_eur']:+,.0f} EUR (placeholder prices).")
    for w in ph.get("warnings", []):
        lines.append(f"- Check: {w}")
    if audience == "homeowner":
        return "Your proposed system:\n" + "\n".join(lines)
    return "\n".join(lines)
