"""Tests for interim_labels, features, model, llm fallbacks and the API (synthetic data, no API key needed)."""
import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

from engine import api, llm
from engine.evaluate import DESIGN_COLUMNS, build_eval_table
from engine.features import build_features, clean_inputs
from engine.interim_labels import build_catalogue, parse_option
from engine.model import DesignModel, snap_pv
from engine.tests.conftest import make_synthetic


# ---------------------------------------------------------------- interim label parser
def parts(*rows):
    cols = ["technology", "component_type", "component_name", "quantity", "module_watt_peak", "inverter_power_kw",
            "battery_capacity_kwh", "wb_charging_speed_kw", "heatpump_nominal_power_kw"]
    return pd.DataFrame([dict(zip(cols, r)) for r in rows])


N = np.nan


def test_parse_package_name():
    d = parse_option(parts(("solar", "Other", "Complete Package 2 Voltara 10.8kWp + 9kWh B", 1, N, N, N, N, N),
                           ("solar", "ModuleFrameConstruction", "Substructure 8.8-15kWp", 24, N, N, N, N, N)))
    assert d["pv_kwp"] == 10.8 and d["battery_kwh"] == 9.0      # the "15kWp" of the substructure name is ignored


def test_parse_module_rows():
    d = parse_option(parts(("solar", "Module", "PV Module 463W TOPCon", 24, 463, N, N, N, N)))
    assert d["pv_kwp"] == pytest.approx(24 * 0.463)


def test_parse_panel_count_and_battery_extensions():
    d = parse_option(parts(("solar", "ModuleFrameConstruction", "Substructure Concrete Roof", 20, N, N, N, N, N),
                           ("ses", "BatteryStorage", "Battery LFP 10kWh", 1, N, 10000, N, N, N),
                           ("ses", "BatteryStorage", "Battery 5kWh Extension B", 1, N, 5000, N, N, N)))
    assert d["pv_kwp"] == pytest.approx(9.0) and d["pv_source"].startswith("panel_count")
    assert d["battery_kwh"] == 15.0


def test_parse_battery_only_wallbox_heatpump():
    d = parse_option(parts(("ses", "BatteryStorage", "Battery 7kWh", 1, N, 7000, N, N, N),
                           ("wallbox", "Wallbox", "Wallbox 11kW", 1, N, N, N, 11000, N),
                           ("heatpump", "Heatpump", "Heat Pump 10.5kW 400V", 1, N, N, N, N, 10000)))
    assert not d["has_pv"] and d["battery_kwh"] == 7 and d["has_wallbox"] and d["wallbox_kw"] == 11
    assert d["has_heatpump"] and d["heatpump_kw"] == 10           # nominal power column (W) wins over the name


def test_parse_single_scaffolding_item_is_not_pv():
    d = parse_option(parts(("solar", "ServiceFee", "Travel & Logistics", 1, N, N, N, N, N),
                           ("solar", "ModuleFrameConstruction", "Substructure Flat Roof Ballast", 1, N, N, N, N, N)))
    assert d["pv_kwp"] == 0 and not d["has_pv"]


def test_catalogue_from_labels(synthetic):
    cat = build_catalogue(synthetic[0], min_count=1)
    assert cat["instA"]["battery_kwh"] == [5.0, 10.0, 15.0] and cat["instA"]["sells_heatpumps"] is False


# ---------------------------------------------------------------- features
def test_features_clean_and_physics_layer():
    df = pd.DataFrame([dict(installer="instA", annual_kwh=4000, has_ev=True, ev_km_year=10000, price_eur_kwh=322),
                       dict(installer="other", annual_kwh=0, has_ev=False)])
    X = build_features(df, [0, 0], ["instA", "instB"])
    assert X.total_demand_kwh.iloc[0] == pytest.approx(4000 + 1800)
    assert np.isnan(X.price_eur_kwh.iloc[0])                        # 322 EUR/kWh is a typo -> unknown
    assert np.isnan(X.annual_kwh.iloc[1])                           # 0 kWh -> unknown
    assert X[["inst_instA", "inst_instB"]].iloc[1].sum() == 0       # unseen installer -> all zeros
    assert clean_inputs(df).annual_kwh.isna().sum() == 1


def test_heat_pump_adds_demand():
    df = pd.DataFrame([dict(installer="instA", annual_kwh=4000, heating="Gas", heating_demand_kwh=17500)])
    assert build_features(df, [7.0], ["instA"]).total_demand_kwh.iloc[0] == pytest.approx(4000 + 5000)


# ---------------------------------------------------------------- model
@pytest.fixture(scope="module")
def trained():
    labels, inputs = make_synthetic(n_per_installer=120, seed=3)
    table = build_eval_table(labels, inputs)
    return DesignModel().fit(table), table


def test_predict_interface(trained):
    model, table = trained
    pred = model.predict(table.head(20))
    assert list(pred.columns) == DESIGN_COLUMNS + ["offer_type", "pv_lo", "pv_hi", "pv_alt1", "pv_alt2"] and len(pred) == 20
    assert (pred.pv_lo <= pred.pv_kwp + 1e-9).all() and (pred.pv_hi >= pred.pv_kwp - 1e-9).all()
    assert ((pred.pv_kwp == 0) | pred.has_pv).all()
    assert model.predict(table.head(0)).empty


def test_battery_snaps_to_installer_catalogue(trained):
    model, table = trained
    pred = model.predict(table)
    for inst, g in pred.join(table.installer).groupby("installer"):
        sizes = set(model.catalogue_[inst]["battery_kwh"]) | {0.0}
        assert set(g.battery_kwh.round(1)) <= sizes


def test_pv_snaps_to_whole_modules(trained):
    model, _ = trained
    kwp = model.propose({"annual_kwh": 5000}, "instA")["design"]["pv"]["kwp"]
    is_module = kwp is None or abs(kwp / 0.45 - round(kwp / 0.45)) < 1e-6
    assert is_module or kwp in model.packages_.get("instA", [])
    assert snap_pv(10.0) == 9.9 and snap_pv(0) == 0


def test_propose_shape_and_reasons(trained):
    model, _ = trained
    out = model.propose({"annual_kwh": 5000, "has_ev": True, "ev_km_year": 15000}, "instA")
    d = out["design"]
    assert set(d) == {"pv", "battery", "wallbox", "heatpump"}
    for c in d.values():
        assert {"include", "confidence", "reasons"} <= set(c) and c["reasons"]
        assert 0 <= c["confidence"] <= 1
    if d["pv"]["include"]:
        lo, hi = d["pv"]["range"]
        assert lo <= d["pv"]["kwp"] <= hi
    assert out["facts"]["total_demand_kwh"] == pytest.approx(5000 + 2700)


def test_locks_are_respected_and_battery_adapts(trained):
    model, _ = trained
    home = {"annual_kwh": 6000}
    d = model.propose(home, "instA", {"pv_kwp": 0, "battery_kwh": 10, "wallbox": True, "heatpump_kw": 0})["design"]
    assert d["pv"]["include"] is False and d["battery"]["kwh"] == 10 and d["wallbox"]["include"] is True
    assert d["heatpump"]["include"] is False and "Fixed by the planner" in d["battery"]["reasons"][0]
    small = model.propose(home, "instA", {"pv_kwp": 3})["design"]["battery"]
    big = model.propose(home, "instA", {"pv_kwp": 20})["design"]["battery"]
    assert (small["kwh"] or 0) <= (big["kwh"] or 0) + 5           # bigger PV never needs a much smaller battery


def test_more_demand_or_ev_never_shrinks_pv(trained):
    model, _ = trained
    base = model.propose({"annual_kwh": 4000}, "instA", {})["design"]["pv"]["kwp"] or 0
    ev = model.propose({"annual_kwh": 4000, "has_ev": True, "ev_km_year": 20000}, "instA", {})["design"]["pv"]["kwp"] or 0
    assert ev >= base


def test_unknown_installer_and_missing_fields(trained):
    model, _ = trained
    out = model.propose({"annual_kwh": 4500}, "brand_new_installer")
    assert out["design"]["pv"]["confidence"] >= 0
    assert model.propose({"annual_kwh": 4500, "load_profile": None, "heating": None}, "instA")["design"]


def test_similar_homes_and_validate(trained):
    model, _ = trained
    sim = model.similar_homes({"annual_kwh": 4500}, "instA", k=5)
    assert len(sim) == 5 and (sim.installer == "instA").all() and sim.similarity.between(0, 1).all()
    flags = model.validate({"annual_kwh": 2500}, "instA", {"pv_kwp": 6, "battery_kwh": 60})
    codes = {f["code"] for f in flags}
    assert "BATTERY_UNUSUAL" in codes and "BATTERY_TOO_BIG_FOR_PV" in codes
    assert all({"component", "level", "message", "percentile"} <= set(f) for f in flags)


def test_save_load_roundtrip(trained, tmp_path):
    model, table = trained
    model.save(tmp_path / "m.joblib")
    again = DesignModel.load(tmp_path / "m.joblib")
    pd.testing.assert_frame_equal(model.predict(table.head(10)), again.predict(table.head(10)))


# ---------------------------------------------------------------- llm fallbacks (no API calls)
@pytest.fixture
def no_claude(monkeypatch):
    monkeypatch.setattr(llm, "claude_available", lambda: False)


@pytest.mark.parametrize("text,home,locks", [
    ("The family is buying an electric car next year, about 15,000 km", {"has_ev": True, "ev_km_year": 15000}, {}),
    ("Customer works from home, no battery please", {"load_profile": "HomeOfficeOnePerson"}, {"battery_kwh": 0}),
    ("Make it 12 kWp with a 10 kWh battery", {}, {"pv_kwp": 12, "battery_kwh": 10}),
    ("Verbrauch 6 MWh im Jahr, ohne Wärmepumpe", {"annual_kwh": 6000}, {"heatpump_kw": 0}),
    ("new EV, 20k km", {"has_ev": True, "ev_km_year": 20000}, {}),
])
def test_rule_refine(no_claude, text, home, locks):
    r = llm.refine(text)
    assert r["source"] == "rules" and r["home_changes"] == home and r["lock_changes"] == locks


def test_rule_refine_nothing_recognised(no_claude):
    r = llm.refine("hello there")
    assert r["home_changes"] == {} and r["lock_changes"] == {} and "rephrase" in r["summary"]


def test_template_explanation(no_claude):
    resp = {"design": {"pv": {"include": True, "kwp": 9.9, "reasons": ["typical"]},
                       "battery": {"include": False, "kwh": None, "reasons": ["none"]}},
            "physics": {"yield_kwh": 9405, "autarky": 0.6, "self_consumption": 0.35, "warnings": ["check roof"]},
            "economics": {"payback_years": 11.2, "savings_first_year_eur": 1500}}
    text = "".join(llm.explain_stream(resp, "homeowner"))
    assert "9.9 kWp" in text and "60%" in text and "check roof" in text


# ---------------------------------------------------------------- API
@pytest.fixture
def client(trained, monkeypatch, no_claude):
    monkeypatch.setattr(api, "get_model", lambda: trained[0])
    return TestClient(api.app)


def test_api_health_and_installers(client):
    assert client.get("/health").json()["status"] == "ok"
    assert set(client.get("/installers").json()) == {"instA", "instB"}


def test_api_design_contract(client):
    r = client.post("/design", json={"installer": "instA", "home": {"annual_kwh": 5000, "has_ev": True},
                                     "locks": {"battery_kwh": 10}})
    assert r.status_code == 200
    body = r.json()
    assert {"design", "physics", "similar_homes", "facts_for_explanation", "model_version", "economics"} <= set(body)
    assert body["design"]["battery"]["kwh"] == 10
    assert {"yield_kwh", "self_consumption", "autarky", "warnings"} <= set(body["physics"])
    assert len(body["similar_homes"]) == 5


@pytest.mark.parametrize("payload,status", [
    ({"installer": "nope", "home": {"annual_kwh": 4500}}, 422),
    ({"installer": "instA", "home": {}}, 422),
    ({"installer": "instA", "home": {"annual_kwh": -5}}, 422),
    ({"installer": "instA", "home": {"annual_kwh": 0}}, 422),          # zero demand: cannot be sized (audit I9)
    ({"installer": "instA", "home": {"annual_kwh": 900}}, 422),        # below 1,500 kWh: placeholder entry
    ({"installer": "instA", "home": {"annual_kwh": 200000}, "locks": {"pv_kwp": 100, "battery_kwh": 100}}, 200),
])
def test_api_design_edge_cases(client, payload, status):
    r = client.post("/design", json=payload)
    assert r.status_code == status
    if status == 422 and payload["installer"] == "instA" and "annual_kwh" in payload["home"] and payload["home"]["annual_kwh"] >= 0:
        assert "1500" in str(r.json()["detail"])


def test_api_validate(client):
    r = client.post("/validate", json={"installer": "instA", "home": {"annual_kwh": 2500},
                                       "design": {"pv_kwp": 6, "battery_kwh": 60, "wallbox": True}})
    codes = {f["code"] for f in r.json()["flags"]}
    assert {"BATTERY_UNUSUAL", "WALLBOX_WITHOUT_EV"} <= codes


def test_api_refine_updates_home_and_design(client):
    r = client.post("/refine", json={"text": "buying an electric car, 15,000 km", "installer": "instA",
                                     "home": {"annual_kwh": 5000}}).json()
    assert r["home"]["has_ev"] is True and r["changes"]["ev_km_year"] == 15000 and r["parsed_by"] == "rules"
    assert r["design"]["facts_for_explanation"]["total_demand_kwh"] == pytest.approx(5000 + 2700)


def test_api_explain_streams_text(client):
    d = client.post("/design", json={"installer": "instA", "home": {"annual_kwh": 5000}}).json()
    r = client.post("/explain", json={"design_response": d, "audience": "planner"})
    assert r.status_code == 200 and "PV" in r.text


def test_api_eval_missing(client, monkeypatch, tmp_path):
    monkeypatch.setattr(api, "ARTIFACTS", tmp_path)
    assert client.get("/eval").status_code == 404


# ---------------------------------------------------------------- heat pump as a customer option
@pytest.fixture
def hp_model(trained):
    """The synthetic installers sell no heat pumps; pretend instA does."""
    import copy
    model = copy.deepcopy(trained[0])
    model.catalogue_["instA"] = {**model.catalogue_["instA"], "sells_heatpumps": True, "heatpump_kw": [5.0, 7.0, 10.0, 12.0]}
    return model


GAS_HOME = {"annual_kwh": 5000, "heating": "Gas", "heating_demand_kwh": 20000}


def test_heatpump_is_offered_not_included(hp_model):
    hp = hp_model.propose(GAS_HOME, "instA")["design"]["heatpump"]
    assert hp["include"] is False and hp["kw"] is None
    assert hp["option"]["available"] and hp["option"]["kw"] == 7.0
    assert "Optional" in hp["reasons"][0]
    assert hp_model.predict(pd.DataFrame([{"installer": "instA", **GAS_HOME}])).has_heatpump.iloc[0] == False  # noqa: E712


def test_heatpump_chosen_raises_demand(hp_model):
    base = hp_model.propose(GAS_HOME, "instA")
    chosen = hp_model.propose(GAS_HOME, "instA", {"heatpump_kw": 7})
    assert chosen["design"]["heatpump"]["include"] and chosen["design"]["heatpump"]["kw"] == 7
    assert chosen["facts"]["total_demand_kwh"] == pytest.approx(base["facts"]["total_demand_kwh"] + 20000 / 3.5)


def test_no_option_for_existing_heatpump_or_non_seller(hp_model):
    assert not hp_model.propose({**GAS_HOME, "heating": "Heatpump"}, "instA")["design"]["heatpump"]["option"]["available"]
    assert not hp_model.propose(GAS_HOME, "instB")["design"]["heatpump"]["option"]["available"]


@pytest.fixture
def hp_client(hp_model, monkeypatch, no_claude):
    monkeypatch.setattr(api, "get_model", lambda: hp_model)
    return TestClient(api.app)


def test_api_heatpump_with_and_without(hp_client):
    body = hp_client.post("/design", json={"installer": "instA", "home": GAS_HOME}).json()
    opt = body["options"]["heatpump"]
    assert opt["available"] and opt["included"] is False and opt["kw"] == 7
    assert opt["with_heatpump"]["heatpump_kw"] == 7 and opt["without_heatpump"]["heatpump_kw"] is None
    assert opt["difference"]["extra_investment_eur"] > 0
    assert opt["with_heatpump"]["load_kwh"] > opt["without_heatpump"]["load_kwh"]
    chosen = hp_client.post("/design", json={"installer": "instA", "home": GAS_HOME, "locks": {"heatpump_kw": 7}}).json()
    assert chosen["design"]["heatpump"]["include"] and chosen["options"]["heatpump"]["included"]


def test_api_refine_customer_wants_heatpump(hp_client):
    r = hp_client.post("/refine", json={"text": "The customer wants a heat pump", "installer": "instA", "home": GAS_HOME}).json()
    assert r["locks"]["heatpump_kw"] == 7 and r["design"]["design"]["heatpump"]["include"]
    r = hp_client.post("/refine", json={"text": "no heat pump", "installer": "instA", "home": GAS_HOME,
                                        "locks": {"heatpump_kw": 7}}).json()
    assert r["locks"]["heatpump_kw"] == 0 and not r["design"]["design"]["heatpump"]["include"]


def test_api_no_option_for_non_seller(client):
    assert client.post("/design", json={"installer": "instA", "home": GAS_HOME}).json()["options"]["heatpump"]["available"] is False


# ---------------------------------------------------------------- access key
def test_api_key_required_when_set(client, monkeypatch):
    payload = {"installer": "instA", "home": {"annual_kwh": 4500}}
    assert client.post("/design", json=payload).status_code == 200          # no key configured: open
    monkeypatch.setenv("ENGINE_API_KEY", "s3cret")
    assert client.post("/design", json=payload).status_code == 401
    assert client.post("/design", json=payload, headers={"X-Engine-Key": "wrong"}).status_code == 401
    assert client.post("/design", json=payload, headers={"X-Engine-Key": "s3cret"}).status_code == 200
    assert client.get("/health").status_code == 200                          # health stays open
    assert client.get("/installers").status_code == 401


def test_pv_threshold_learned_out_of_fold(trained):
    model, _ = trained
    assert 0.2 <= model.pv_threshold_ <= 0.6


# ---------------------------------------------------------------- offer type + "Is there already PV?"
def test_tristate_existing_pv():
    from engine.features import tristate
    out = tristate(pd.Series([True, False, None, np.nan, 1, 0]))
    assert out.iloc[0] == 1 and out.iloc[1] == 0 and np.isnan(out.iloc[2]) and np.isnan(out.iloc[3])


def test_offer_type_and_planner_answer(synthetic):
    from engine.evaluate import planner_answer
    t = build_eval_table(*synthetic)
    assert set(t.offer_type) <= {"new_system", "pv_extension", "battery_retrofit", "wallbox_only", "heatpump_only", "no_components"}
    a = planner_answer(t)
    assert (a[t.offer_type == "battery_retrofit"] == 1).all() and (a[t.offer_type == "new_system"] == 0).all()


def test_chain_offer_types_are_consistent(trained):
    model, table = trained
    pred = model.predict(table)
    assert set(pred.offer_type) <= {"pv", "battery_retrofit", "wallbox_only", "other"}
    assert (pred[pred.offer_type == "battery_retrofit"].has_battery).all()
    assert not (pred[pred.offer_type == "battery_retrofit"].has_pv).any()
    assert (pred[pred.offer_type == "wallbox_only"].has_wallbox).all()
    assert not pred[pred.offer_type == "other"][["has_pv", "has_battery"]].any().any()


def test_existing_pv_answer_changes_the_decision(trained):
    model, _ = trained
    home = {"annual_kwh": 4500}
    yes = model.propose({**home, "has_existing_pv": True}, "instA")
    no = model.propose({**home, "has_existing_pv": False}, "instA")
    unknown = model.propose(home, "instA")
    assert yes["facts"]["existing_pv_known"] and not unknown["facts"]["existing_pv_known"]
    p = lambda d: d["facts"]["probabilities"]["pv"]
    assert p(yes) <= p(unknown) + 0.05 and p(no) >= p(unknown) - 0.05     # "already PV" makes new PV less likely


def test_locked_battery_without_pv_is_a_retrofit(trained):
    model, _ = trained
    d = model.propose({"annual_kwh": 4500}, "instA", {"pv_kwp": 0, "battery_kwh": 5})
    assert d["facts"]["offer_type"] == "battery_retrofit" and d["design"]["battery"]["kwh"] == 5


def test_rule_refine_existing_pv(no_claude):
    assert llm.refine("They already have solar panels on the roof")["home_changes"] == {"has_existing_pv": True}
    assert llm.refine("No PV on the roof yet")["home_changes"] == {"has_existing_pv": False}


def test_api_accepts_existing_pv_answer(client):
    r = client.post("/design", json={"installer": "instA", "home": {"annual_kwh": 4500, "has_existing_pv": True}})
    assert r.status_code == 200 and r.json()["facts_for_explanation"]["existing_pv_known"] is True


def test_snap_to_installer_package(trained):
    model, _ = trained
    model = __import__("copy").deepcopy(model)
    model.packages_ = {"instA": [10.8, 13.5]}
    assert model.snap_pv_to_catalogue(10.3, "instA") == (10.8, "the installer's standard 10.8 kWp package")
    assert model.snap_pv_to_catalogue(12.0, "instA")[1] is None                  # > 1 kWp from any package
    assert model.snap_pv_to_catalogue(12.0, "instA")[0] == 12.15                 # 26.7 -> 27 modules
    assert model.snap_pv_to_catalogue(0, "instA") == (0.0, None)
    assert 0.0 <= model.battery_threshold_ <= 0.55                              # 0.0 = rule "always a battery" won


# ---------------------------------------------------------------- Mark's demo bugs + model-or-rule
def test_typed_4500_is_a_real_value(trained):
    from engine.model import home_to_row
    assert home_to_row({"annual_kwh": 4500}, "instA")["demand_is_default"] is False


def test_ev_adds_wallbox_and_pv(trained):
    model, _ = trained
    base = model.propose({"annual_kwh": 5000, "has_existing_pv": False}, "instA")["design"]
    ev = model.propose({"annual_kwh": 5000, "has_existing_pv": False, "has_ev": True, "ev_km_year": 15000}, "instA")["design"]
    assert (ev["pv"]["kwp"] or 0) >= (base["pv"]["kwp"] or 0)
    if model.wallbox_mode_ == "ev_rule":
        assert ev["wallbox"]["include"] is True
    assert model.wallbox_mode_ in ("model", "ev_rule", "never") and 0 <= model.ev_uplift_kwp_ <= 3


# ---------------------------------------------------------------- roof inputs (#27)
def test_roof_cap_and_orientation(client):
    home = {"annual_kwh": 9000, "has_existing_pv": False}
    free = client.post("/design", json={"installer": "instA", "home": home}).json()
    kwp = free["design"]["pv"]["kwp"]
    capped = client.post("/design", json={"installer": "instA", "home": {**home, "roof_max_kwp": 4.0}}).json()
    assert capped["design"]["pv"]["kwp"] <= 4.0 and capped["design"]["pv"]["range"][1] <= 4.0
    if kwp and kwp > 4.0:
        assert any("roof capacity" in r for r in capped["design"]["pv"]["reasons"])
    east = client.post("/design", json={"installer": "instA", "home": {**home, "roof_azimuth": 90, "roof_pitch": 30}}).json()
    south = client.post("/design", json={"installer": "instA", "home": {**home, "roof_azimuth": 180, "roof_pitch": 30}}).json()
    if east["design"]["pv"]["kwp"] == south["design"]["pv"]["kwp"]:
        assert east["physics"]["yield_kwh"] < south["physics"]["yield_kwh"]
    locked = client.post("/design", json={"installer": "instA", "home": {**home, "roof_max_kwp": 4.0},
                                          "locks": {"pv_kwp": 8}}).json()
    assert locked["design"]["pv"]["kwp"] == 8
    assert any(f["code"] == "ROOF_CAPACITY_EXCEEDED" for f in locked["physics"]["flags"])
    bad = client.post("/design", json={"installer": "instA", "home": {**home, "roof_azimuth": 400}})
    assert bad.status_code == 422


def test_linear_blend_is_monotone(trained):
    model, _ = trained
    assert model.pv_blend_w_ == 0.0                                   # blend is off by default
    labels, inputs = make_synthetic(n_per_installer=120, seed=3)
    blended = DesignModel(blend=True).fit(build_eval_table(labels, inputs))
    assert blended.pv_blend_w_ in (0.0, 0.3, 0.5, 0.7)
    lin = model.pv_linear_
    for c in ("annual_kwh", "has_ev", "ev_km"):
        if c in lin.cols_:
            assert lin.reg_.coef_[lin.cols_.index(c)] >= 0
    assert "total_demand_kwh" not in lin.cols_


def test_battery_mode_and_catalogue(trained):
    model, table = trained
    assert model.battery_mode_ in ("classifier", "mix")
    pred = model.predict(table)
    for inst, g in pred.join(table.installer).groupby("installer"):
        assert set(g.battery_kwh.round(1)) <= set(model.catalogue_[inst]["battery_kwh"]) | {0.0}


def test_pv_alternatives(trained):
    model, _ = trained
    d = model.propose({"annual_kwh": 6000, "has_existing_pv": False}, "instA")["design"]["pv"]
    if d["include"] and model.pv_size_clf_ is not None:
        alts = d["alternatives"]
        assert len(alts) <= 2 and all(abs(a["kwp"] - d["kwp"]) > 0.05 and 0 <= a["share"] <= 1 for a in alts)
        capped = model.propose({"annual_kwh": 6000, "has_existing_pv": False, "roof_max_kwp": 5.0}, "instA")["design"]["pv"]
        assert all(a["kwp"] <= 5.0 for a in capped.get("alternatives", []))
