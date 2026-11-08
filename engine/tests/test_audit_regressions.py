"""Regression tests for the findings of the 8 Nov audit (D:\\thinc\\AUDIT.md, issue #50). Synthetic data, no API key."""
import copy
import json

import pandas as pd
import pytest
from fastapi.testclient import TestClient

from engine import api, llm, physics
from engine.evaluate import build_eval_table
from engine.features import build_features
from engine.interim_labels import build_catalogue
from engine.model import DesignModel, home_to_row
from engine.tests.conftest import make_synthetic


@pytest.fixture(scope="module")
def trained():
    labels, inputs = make_synthetic(n_per_installer=120, seed=3)
    return DesignModel().fit(build_eval_table(labels, inputs))


@pytest.fixture
def mixed(trained):
    """Force the battery kWh/kWp mix on, so the proposed size can differ from the classifier's class."""
    m = copy.deepcopy(trained)
    m.battery_mode_, m.battery_ratio_ = "mix", {"instA": 0.6, "instB": 1.4}
    return m


HOMES = [{"annual_kwh": 2000}, {"annual_kwh": 2500}, {"annual_kwh": 3500}, {"annual_kwh": 4500}, {"annual_kwh": 6000},
         {"annual_kwh": 8000, "has_ev": True, "ev_km_year": 15000}]


# --- I1: battery range / alternatives / text consistent with the size shown ----------------------------------
@pytest.mark.parametrize("installer", ["instA", "instB"])
def test_battery_range_contains_the_proposed_size_and_alternatives_are_real(mixed, installer):
    for home in HOMES:
        b = mixed.propose(home, installer)["design"]["battery"]
        if not b["include"]:
            continue
        lo, hi = b["range"]
        assert lo - 1e-9 <= b["kwh"] <= hi + 1e-9, (home, b)
        assert all(0 < a["share"] <= 1 for a in b["alternatives"]), (home, b)      # never a "0 %" alternative


def test_battery_reason_never_says_zero_percent_of_similar_designs(mixed):
    for installer in ("instA", "instB"):
        for home in HOMES:
            b = mixed.propose(home, installer)["design"]["battery"]
            text = " ".join(b["reasons"])
            assert "0% of similar designs" not in text and "(0%)" not in text, text
            if b["include"] and "the catalogue size between" in text:
                assert f"size {b['kwh']:g} kWh" in text


# --- I5: probabilities are called what they are ---------------------------------------------------------------
def test_reasons_say_model_confidence_not_similar_homes(trained):
    d = trained.propose({"annual_kwh": 5000, "has_ev": True}, "instA")["design"]
    assert "Model confidence" in d["pv"]["reasons"][0]
    assert "of similar homes got PV" not in d["pv"]["reasons"][0]
    assert all(c["confidence"] is not None and 0 <= c["confidence"] <= 1 for c in d.values())


# --- I2: demand_is_default travels with the home ---------------------------------------------------------------
def test_demand_is_default_flag_is_respected():
    assert home_to_row({"annual_kwh": 4500}, "instA")["demand_is_default"] is False                 # typed value = real
    assert home_to_row({"annual_kwh": 4500, "demand_is_default": True}, "instA")["demand_is_default"] is True
    assert home_to_row({"annual_kwh": 4500, "demand_is_default": None}, "instA")["demand_is_default"] is False
    df = pd.DataFrame([home_to_row({"annual_kwh": 4500, "demand_is_default": True}, "instA"),
                       home_to_row({"annual_kwh": 4500}, "instA")])
    X = build_features(df, [0, 0], ["instA"])
    assert list(X.demand_is_default) == [1, 0]


def test_api_accepts_demand_is_default(trained, monkeypatch):
    monkeypatch.setattr(api, "get_model", lambda: trained)
    monkeypatch.setattr(llm, "claude_available", lambda: False)
    c = TestClient(api.app)
    r = c.post("/design", json={"installer": "instA", "home": {"annual_kwh": 4500, "demand_is_default": True}})
    assert r.status_code == 200
    assert r.json()["facts_for_explanation"]["home"]["demand_is_default"] is True


# --- I3: one heat pump size list for the option and the physics check -----------------------------------------
def test_heatpump_sizes_are_the_sold_ones_not_rounded():
    labels = pd.DataFrame([dict(installer="x", project_id=f"p{i}", option_number=1, is_primary=True, has_pv=True, pv_kwp=9.0,
                                has_battery=True, battery_kwh=10.0, has_wallbox=False, has_heatpump=True, heatpump_kw=k, wallbox_kw=11.0)
                           for i, k in enumerate([5.5, 7.5, 10.5, 10.5, 12.5] * 2)])
    cat = build_catalogue(labels, min_count=1)
    assert cat["x"]["heatpump_kw"] == [5.5, 7.5, 10.5, 12.5]            # not 6 / 8 / 10 / 12
    assert physics.heatpump_size_kw(20000)[0] == 8.0


def test_heatpump_option_and_sanity_check_use_the_same_sizes(trained):
    m = copy.deepcopy(trained)
    m.catalogue_["instA"] = {**m.catalogue_["instA"], "sells_heatpumps": True, "heatpump_kw": [5.5, 7.5, 8.0, 10.5, 12.5]}
    home = {"annual_kwh": 5000, "heating": "Gas", "heating_demand_kwh": 20000}
    kw = m.heatpump_option(home, "instA")["kw"]
    assert kw == 8.0
    flags = m.validate(home, "instA", {"pv_kwp": 9, "battery_kwh": 10, "heatpump_kw": kw})
    assert not any(f["code"] == "HEATPUMP_SIZE_MISMATCH" for f in flags)       # the offered size never contradicts itself


# --- I9: a demand that cannot be sized is rejected, not silently designed -------------------------------------
def test_tiny_demand_is_rejected(trained, monkeypatch):
    monkeypatch.setattr(api, "get_model", lambda: trained)
    monkeypatch.setattr(llm, "claude_available", lambda: False)
    c = TestClient(api.app)
    for kwh in (0, 1, 1499):
        r = c.post("/design", json={"installer": "instA", "home": {"annual_kwh": kwh}})
        assert r.status_code == 422, kwh
    assert c.post("/design", json={"installer": "instA", "home": {"annual_kwh": 1500}}).status_code == 200


# --- determinism (audit E) -------------------------------------------------------------------------------------
def test_same_request_same_json(trained, monkeypatch):
    monkeypatch.setattr(api, "get_model", lambda: trained)
    monkeypatch.setattr(llm, "claude_available", lambda: False)
    c = TestClient(api.app)
    req = {"installer": "instB", "home": {"annual_kwh": 6000, "has_ev": True, "ev_km_year": 12000}}
    a, b = c.post("/design", json=req).json(), c.post("/design", json=req).json()
    assert json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)
