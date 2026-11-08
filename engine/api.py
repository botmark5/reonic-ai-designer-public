"""
engine/api.py - the HTTP API the website talks to (contract: docs/api.md).

    .venv\\Scripts\\uvicorn engine.api:app --reload --port 8000      ->  http://localhost:8000/docs

Endpoints
    POST /design    complete design + physics + economics + heat pump option (with/without) + similar homes
    POST /validate  where a planner's design sits among similar homes + physics sanity flags
    POST /refine    planner text -> input changes (Claude Haiku or keyword fallback) -> new /design
    POST /explain   streamed plain-language explanation (Claude Sonnet or template fallback)
    GET  /eval      metrics on held-out projects (written by `python -m engine.train`)
    GET  /heldout        locked test-set ids + curated demo cases (ids and text only)
    GET  /project/{id}   a real project: home, expert design, all variants, and our proposal
    GET  /installers     known installers and what they sell;  GET /health
Access: if ENGINE_API_KEY is set, send `X-Engine-Key: <key>` with every request (all except /health).
The engine decides every size; Claude only parses text and writes explanations.
"""
from __future__ import annotations

import json
import logging
import os
import threading
import warnings
from contextlib import asynccontextmanager
from functools import lru_cache
from typing import Literal, Optional

import numpy as np
import pandas as pd
import secrets

from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, field_validator

from engine import llm, physics
from engine.evaluate import ARTIFACTS, build_eval_table, derive_offer_type, inputs_from_labels, load_inputs, planner_answer
from engine.interim_labels import get_labels
from engine.model import MODEL_PATH, DesignModel, contextualise_pv_flags, home_to_physics

warnings.filterwarnings("ignore", message="X does not have valid feature names")
log = logging.getLogger("engine.api")
MODEL_VERSION = "v1"


# ---------------------------------------------------------------------------
# Request models (field names = docs/api.md; extra optional fields are marked)
# ---------------------------------------------------------------------------
MIN_DEMAND_KWH = 1500      # below this the entry is a placeholder (21 projects at 0-1 kWh in the data): nothing can be sized


class Home(BaseModel):
    annual_kwh: float = Field(ge=0, description=f"yearly household electricity demand (without EV / new heat pump), >= {MIN_DEMAND_KWH}")
    # "the planner left the tool's default 4,500 kWh" (web sends it; the model learned that default = consumption unknown)
    demand_is_default: Optional[bool] = Field(None, description="true only when annual_kwh was left at the dataset default")

    @field_validator("annual_kwh")
    @classmethod
    def _demand_sizeable(cls, v: float) -> float:
        if v < MIN_DEMAND_KWH:
            raise ValueError(f"annual_kwh {v:g} is below {MIN_DEMAND_KWH} kWh: a home cannot be sized from it (check the input)")
        return v
    price_eur_kwh: Optional[float] = Field(None, gt=0, le=2)
    load_profile: Optional[str] = "H0"
    has_ev: bool = False
    ev_km_year: Optional[float] = Field(None, ge=0)
    existing_pv_kwp: Optional[float] = Field(None, ge=0, description="PV already on the roof; 0 = none")
    has_existing_pv: Optional[bool] = Field(None, description="'Is there already PV on the roof?' yes/no; null = unknown")
    existing_battery_kwh: Optional[float] = Field(None, ge=0)
    heating: Optional[str] = None
    heating_demand_kwh: Optional[float] = Field(None, ge=0)
    roof_type: Optional[str] = None
    house_sqm: Optional[float] = None
    inhabitants: Optional[int] = None
    # optional extras (not in api.md v0, safe to omit)
    existing_wallbox: bool = False
    orientation_deg: Optional[float] = Field(None, ge=0, le=360, description="180 = south")
    tilt_deg: Optional[float] = Field(None, ge=0, le=90)
    # roof from the Google Solar API (optional): caps PV and drives the yield physics
    roof_max_kwp: Optional[float] = Field(None, gt=0, le=200, description="max PV the roof fits, kWp")
    roof_azimuth: Optional[float] = Field(None, ge=0, le=360, description="degrees clockwise from north, 180 = south")
    roof_pitch: Optional[float] = Field(None, ge=0, le=90, description="roof tilt in degrees")
    offer_date: Optional[str] = Field(None, description="ISO date; empty = today")


class Locks(BaseModel):
    pv_kwp: Optional[float] = Field(None, ge=0, description="0 = no PV")
    battery_kwh: Optional[float] = Field(None, ge=0, description="0 = no battery")
    wallbox: Optional[bool] = None
    heatpump_kw: Optional[float] = Field(None, ge=0, description="0 = no heat pump")


class DesignRequest(BaseModel):
    installer: str
    home: Home
    locks: Locks = Locks()


class PlannerDesign(BaseModel):
    pv_kwp: Optional[float] = Field(None, ge=0)
    battery_kwh: Optional[float] = Field(None, ge=0)
    wallbox: Optional[bool] = None
    heatpump_kw: Optional[float] = Field(None, ge=0)


class ValidateRequest(BaseModel):
    installer: str
    home: Home
    design: PlannerDesign


class RefineRequest(BaseModel):
    text: str = Field(min_length=1, max_length=2000)
    home: Home
    locks: Locks = Locks()
    installer: Optional[str] = Field(None, description="extra vs api.md v0; default = the larger installer")


class ExplainRequest(BaseModel):
    design_response: dict
    audience: Literal["planner", "homeowner"] = "planner"
    language: Literal["en", "de"] = "en"


# ---------------------------------------------------------------------------
# Lazy singletons
# ---------------------------------------------------------------------------
@lru_cache(maxsize=1)
def get_model() -> DesignModel:
    if MODEL_PATH.exists():
        return DesignModel.load(MODEL_PATH)
    log.warning("no trained model at %s: training now (run `python -m engine.train` for metrics)", MODEL_PATH)
    labels, source = get_labels()
    inputs = inputs_from_labels(labels)
    model = DesignModel().fit(build_eval_table(labels, inputs if inputs is not None else load_inputs()))
    model.labels_source_ = source
    model.save(MODEL_PATH)
    return model


@lru_cache(maxsize=1)
def get_projects() -> tuple[pd.DataFrame, pd.DataFrame]:
    """(inputs per project, all label rows) for /project/{id}; needs data/raw."""
    labels, _ = get_labels()
    inputs = inputs_from_labels(labels)
    return (inputs if inputs is not None else load_inputs()), labels


def _py(obj):
    """numpy / pandas values -> plain JSON types; NaN / infinity -> null (not valid JSON)."""
    def clean(o):
        if isinstance(o, dict):
            return {k: clean(v) for k, v in o.items()}
        if isinstance(o, (list, tuple)):
            return [clean(v) for v in o]
        if hasattr(o, "item") and not isinstance(o, (str, bytes)):
            o = o.item()
        if isinstance(o, float) and not np.isfinite(o):
            return None
        if o is pd.NaT:
            return None
        return o if isinstance(o, (str, int, float, bool, type(None))) else str(o)
    return clean(obj)


def _check_installer(model: DesignModel, installer: str):
    if installer not in model.installers_:
        raise HTTPException(422, f"Unknown installer {installer!r}. Known: {model.installers_}")


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------
def require_key(x_engine_key: Optional[str] = Header(None)):
    """
    Optional access key. When ENGINE_API_KEY is set (e.g. behind a public tunnel), every request except
    /health and /docs must send the header `X-Engine-Key: <key>`. Unset (local development) = open.
    Protects the Reonic-derived data (/project, similar homes) and the Claude credits (/refine, /explain).
    """
    expected = os.environ.get("ENGINE_API_KEY")
    if expected and not (x_engine_key and secrets.compare_digest(x_engine_key, expected)):
        raise HTTPException(401, "Missing or wrong X-Engine-Key header.")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Warm up: the first Claude structured-output call takes ~25 s (schema compilation), later ones ~2 s.
    One cheap call at start-up so the first /refine in a demo is fast. Never blocks start-up."""
    if llm.claude_available():
        threading.Thread(target=lambda: llm.refine("warm-up, no changes", {}), daemon=True).start()
    yield


app = FastAPI(title="Reonic AI Designer engine", version=MODEL_VERSION, lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=os.environ.get("ENGINE_CORS_ORIGINS", "*").split(","),
                   allow_methods=["*"], allow_headers=["*"])


@app.get("/health")
def health():
    model = get_model()
    return dict(status="ok", model_version=MODEL_VERSION, labels_source=getattr(model, "labels_source_", "unknown"),
                trained_on_projects=model.n_train_, claude=llm.claude_available())


@app.get("/installers", dependencies=[Depends(require_key)])
def installers():
    model = get_model()
    return {i: model.catalogue_.get(i, {}) for i in model.installers_}


def _evaluate_design(home: dict, d: dict, installer: str | None = None):
    """Physics + economics for a proposed design (heat pump checks use the installer's own sizes)."""
    system = physics.System(pv_kwp=d["pv"]["kwp"] or 0.0, battery_kwh=d["battery"]["kwh"] or 0.0,
                            heatpump_kw=d["heatpump"]["kw"] or 0.0, wallbox=d["wallbox"]["include"])
    ph_home = home_to_physics(home)
    sim = physics.simulate(ph_home, system)
    sizes = get_model().heatpump_sizes(installer) if installer else physics.HP_CATALOGUE_KW
    return sim, physics.sanity_flags(ph_home, system, sim, hp_catalogue=sizes), physics.economics(ph_home, system, sim)


def _contextualise_flags(model: DesignModel, home: dict, installer: str, d: dict, flags: list[dict]) -> list[dict]:
    """
    /design: a physics "PV_OVERSIZED" warning becomes information when the 40 most similar past homes of this installer
    show the size is typical for THIS consumption (model.contextualise_pv_flags), so the engine never calls its own
    expert-style proposal implausible (issue #66). Errors (> p99) are never downgraded.
    """
    if not any(f["code"] == "PV_OVERSIZED" for f in flags):
        return flags
    try:
        checks = model.validate(home, installer, dict(pv_kwp=d["pv"]["kwp"], battery_kwh=d["battery"]["kwh"],
                                                     wallbox=d["wallbox"]["include"], heatpump_kw=d["heatpump"]["kw"]))
    except Exception:            # validation is a bonus: never break /design because of it
        return flags
    typical = [c for c in checks if c.get("code") == "PV_TYPICAL"]
    return contextualise_pv_flags(flags + typical)[:len(flags)] if typical else flags


def _variant_summary(d: dict, sim, eco) -> dict:
    return dict(pv_kwp=d["pv"]["kwp"], battery_kwh=d["battery"]["kwh"], heatpump_kw=d["heatpump"]["kw"],
                capex_total_eur=round(eco["capex_total_eur"]), savings_first_year_eur=round(eco["savings_first_year_eur"]),
                heating_savings_eur=round(eco["savings_breakdown_eur"]["heating"]),
                payback_years=None if eco["payback_years"] is None else round(eco["payback_years"], 1),
                net_benefit_lifetime_eur=round(eco["net_benefit_lifetime_eur"]),
                autarky=round(sim.autarky, 3), load_kwh=round(sim.load_kwh))


def heatpump_choice(installer: str, home: dict, locks: dict, base_design: dict, base_sim, base_eco) -> dict:
    """The heat pump as a customer choice: the full design WITH and WITHOUT it, side by side."""
    model = get_model()
    option = base_design["heatpump"]["option"]
    if not option["available"]:
        return dict(available=False, reasons=option["reasons"])
    included = bool(base_design["heatpump"]["include"])
    other_locks = {**locks, "heatpump_kw": 0.0 if included else option["kw"]}
    other = model.propose(home, installer, other_locks)["design"]
    o_sim, _, o_eco = _evaluate_design(home, other, installer)
    if included:
        with_, without = (base_design, base_sim, base_eco), (other, o_sim, o_eco)
    else:
        with_, without = (other, o_sim, o_eco), (base_design, base_sim, base_eco)
    w, wo = _variant_summary(*with_), _variant_summary(*without)
    return dict(available=True, included=included, kw=option["kw"], reasons=option["reasons"],
                with_heatpump=w, without_heatpump=wo,
                difference=dict(extra_investment_eur=w["capex_total_eur"] - wo["capex_total_eur"],
                                extra_savings_per_year_eur=w["savings_first_year_eur"] - wo["savings_first_year_eur"],
                                extra_net_benefit_lifetime_eur=w["net_benefit_lifetime_eur"] - wo["net_benefit_lifetime_eur"]),
                how_to_choose="Send locks.heatpump_kw = kw to include it, 0 to exclude it.")


def design_response(installer: str, home: dict, locks: dict) -> dict:
    """The /design logic, reused by /refine and /project."""
    model = get_model()
    _check_installer(model, installer)
    proposal = model.propose(home, installer, locks)
    d = proposal["design"]
    sim, flags, eco = _evaluate_design(home, d, installer)
    flags = _contextualise_flags(model, home, installer, d, flags)
    similar = model.similar_homes(home, installer, k=5, heatpump_kw=d["heatpump"]["kw"] or 0.0)
    return _py(dict(
        design=d,
        physics=dict(yield_kwh=round(sim.yield_kwh), self_consumption=round(sim.self_consumption, 3),
                     autarky=round(sim.autarky, 3), load_kwh=round(sim.load_kwh), grid_import_kwh=round(sim.grid_import_kwh),
                     feed_in_kwh=round(sim.feed_in_kwh), battery_cycles=round(sim.battery_cycles),
                     warnings=[f["message"] for f in flags if f["level"] in ("warn", "error")], flags=flags,
                     assumptions=sim.assumptions),
        economics=dict(capex_total_eur=round(eco["capex_total_eur"]), savings_first_year_eur=round(eco["savings_first_year_eur"]),
                       payback_years=None if eco["payback_years"] is None else round(eco["payback_years"], 1),
                       savings_lifetime_eur=round(eco["savings_lifetime_eur"]), assumptions=eco["assumptions"]),
        options=dict(heatpump=heatpump_choice(installer, home, locks, d, sim, eco)),
        similar_homes=[dict(project_id=r.project_id, annual_kwh=r.annual_kwh, pv_kwp=round(r.pv_kwp, 2),
                            battery_kwh=r.battery_kwh, similarity=r.similarity) for r in similar.itertuples()],
        facts_for_explanation={**proposal["facts"], "home": home,
                               "demand": dict(household_kwh=sim.household_kwh, ev_kwh=sim.ev_kwh, heatpump_kwh=sim.heatpump_kwh)},
        model_version=f"{MODEL_VERSION} ({getattr(model, 'labels_source_', 'unknown labels')})",
    ))


@app.post("/design", dependencies=[Depends(require_key)])
def design(req: DesignRequest):
    return design_response(req.installer, req.home.model_dump(), req.locks.model_dump())


@app.post("/validate", dependencies=[Depends(require_key)])
def validate(req: ValidateRequest):
    model = get_model()
    _check_installer(model, req.installer)
    return _py({"flags": model.validate(req.home.model_dump(), req.installer, req.design.model_dump())})


@app.post("/refine", dependencies=[Depends(require_key)])
def refine(req: RefineRequest):
    model = get_model()
    installer = req.installer or max(model.installers_, key=lambda i: (model.reference_.installer == i).sum())
    home, locks = req.home.model_dump(), req.locks.model_dump()
    parsed = llm.refine(req.text, home)
    home.update(parsed["home_changes"])
    lock_changes = dict(parsed["lock_changes"])
    want_hp = lock_changes.pop("want_heatpump", None)          # "add a heat pump" -> the offered size
    if want_hp is not None and "heatpump_kw" not in lock_changes:
        option = model.heatpump_option(home, installer)
        lock_changes["heatpump_kw"] = (option["kw"] or 0.0) if want_hp else 0.0
    locks.update(lock_changes)
    parsed["lock_changes"] = lock_changes
    return dict(changes={**parsed["home_changes"], **parsed["lock_changes"]}, summary=parsed["summary"],
                parsed_by=parsed["source"], home=home, locks=locks, design=design_response(installer, home, locks))


@app.post("/explain", dependencies=[Depends(require_key)])
def explain(req: ExplainRequest):
    return StreamingResponse(llm.explain_stream(req.design_response, req.audience, req.language),
                             media_type="text/plain; charset=utf-8")


@app.get("/eval", dependencies=[Depends(require_key)])
def eval_results():
    path = ARTIFACTS / "eval_results.json"
    if not path.exists():
        raise HTTPException(404, "No evaluation yet: run `python -m engine.train`.")
    return json.loads(path.read_text())


HELDOUT_FILES = (("demo_reality.json", "cases", "two_houses_"), ("demo_projects.json", "projects", ""))


@lru_cache(maxsize=1)
def heldout_lists() -> dict:
    """Locked test-set ids + curated demo cases (ids and text only), from engine/artifacts; built from the labels
    with the same fixed rules when a file is missing (locked_split seed 42, engine/demo_set.py pick_roles)."""
    from engine.evaluate import locked_split

    ids_path = ARTIFACTS / "test_ids.json"
    ids = json.loads(ids_path.read_text()).get("test_project_ids", []) if ids_path.exists() else []
    demo, seen = [], set()
    for name, key, prefix in HELDOUT_FILES:
        path = ARTIFACTS / name
        for case in (json.loads(path.read_text()).get(key, []) if path.exists() else []):
            if case["project_id"] not in seen:
                seen.add(case["project_id"])
                demo.append(dict(role=prefix + case["role"], why=case["why"], project_id=case["project_id"]))
    if not ids or not demo:
        try:
            from engine.demo_set import pick_roles

            labels, _ = get_labels()
            table = build_eval_table(labels, inputs_from_labels(labels))
            _, test = locked_split(table, ids_path)
            ids = ids or sorted(test.project_id)
            if not demo:
                demo = [dict(role=r, why=w, project_id=pid) for r, pid, w in pick_roles(test.reset_index(drop=True), labels)]
        except Exception as e:  # no labels on this host: return what exists, never invent
            log.warning("held-out lists incomplete: %s", e)
    return dict(test_project_ids=list(ids), demo_projects=demo)


@app.get("/heldout", dependencies=[Depends(require_key)])
def heldout():
    """The locked held-out project ids and the curated demo cases, for hosts without engine/artifacts (Vercel)."""
    return heldout_lists()


@app.get("/project/{project_id}", dependencies=[Depends(require_key)])
def project(project_id: str,
            answered: bool = Query(False, description="true = the planner answered 'Solar already on the roof?'; the answer is "
                                                      "derived from the expert offer (battery-only = yes, new system = no), "
                                                      "so this is a what-if, never an accuracy (issue #47)")):
    inputs, labels = get_projects()
    row = inputs[inputs.project_id == project_id]
    if row.empty:
        raise HTTPException(404, f"Unknown project {project_id!r}")
    r = row.iloc[0]
    nan = lambda v: None if v is None or (isinstance(v, float) and np.isnan(v)) or v is pd.NaT else v
    # the data's "left at the default 4,500 kWh" flag travels with the home, exactly as in training / evaluation
    default_flag = bool(r.demand_is_default) if "demand_is_default" in row.columns and pd.notna(r.demand_is_default) else None
    home = dict(annual_kwh=nan(r.annual_kwh) or 0.0, demand_is_default=default_flag,
                price_eur_kwh=nan(r.price_eur_kwh) if 0 < (r.price_eur_kwh or 0) <= 1 else None,
                load_profile=r.load_profile, has_ev=bool(r.has_ev), ev_km_year=nan(r.ev_km_year), heating=nan(r.heating),
                heating_demand_kwh=nan(r.heating_demand_kwh), existing_pv_kwp=None, existing_battery_kwh=None,
                existing_wallbox=bool(r.existing_wallbox),
                offer_date=None if pd.isna(r.offer_date) else r.offer_date.isoformat())
    options = labels[labels.project_id == project_id].sort_values("option_number")
    cols = ["option_number", "is_primary", "pv_kwp", "battery_kwh", "has_wallbox", "heatpump_kw"]
    variants = options[cols].to_dict("records")
    expert = next((v for v in variants if v["is_primary"]), None)
    # the planner's answer to "Solar already on the roof?", exactly as the answered-mode evaluation derives it
    # (evaluate.planner_answer): yes for battery retrofits / PV extensions, no for new systems, unknown otherwise
    answer = None
    if answered and not options.empty:
        primary = options[options.is_primary.astype(bool)] if options.is_primary.astype(bool).any() else options.head(1)
        if "offer_type" not in primary.columns:
            primary = primary.assign(offer_type=derive_offer_type(primary))
        a = planner_answer(primary).iloc[0]
        answer = None if pd.isna(a) else bool(a)
        home["has_existing_pv"] = answer
    ours = design_response(r.installer, home, {}) if home["annual_kwh"] >= MIN_DEMAND_KWH else None
    return _py(dict(project_id=project_id, installer=r.installer, home=home, expert=expert, variants=variants, ours=ours,
                    answered=bool(answered), planner_answer=answer))
