"""pick_reality: held-out /reality cases where the engine is close to the expert (synthetic data, no Reonic data)."""
import numpy as np
import pandas as pd

from engine.demo_set import _close, pick_reality


def _test_table():
    base = dict(consumption_known=True, demand_is_default=False, has_heatpump=False, heating="Electric")
    rows = [
        # typical PV + battery: p1 is closest to the median but the engine is far off, p2 is close
        dict(project_id="p1", offer_type="new_system", annual_kwh=4500, has_ev=False, has_pv=True, pv_kwp=9.0,
             has_battery=True, battery_kwh=10.0, has_wallbox=False),
        dict(project_id="p2", offer_type="new_system", annual_kwh=4800, has_ev=False, has_pv=True, pv_kwp=9.5,
             has_battery=True, battery_kwh=10.0, has_wallbox=False),
        dict(project_id="p3", offer_type="new_system", annual_kwh=4000, has_ev=False, has_pv=True, pv_kwp=8.0,
             has_battery=True, battery_kwh=7.5, has_wallbox=False),
        # EV + wallbox
        dict(project_id="e1", offer_type="new_system", annual_kwh=6000, has_ev=True, has_pv=True, pv_kwp=11.0,
             has_battery=True, battery_kwh=10.0, has_wallbox=True),
        # battery retrofit: engine proposes no new PV and a 5 kWh battery
        dict(project_id="r1", offer_type="battery_retrofit", annual_kwh=5000, has_ev=False, has_pv=False, pv_kwp=0.0,
             has_battery=True, battery_kwh=5.0, has_wallbox=False),
        # gas home with a heat-pump option (only used when no retrofit qualifies)
        dict(project_id="g1", offer_type="new_system", annual_kwh=5000, has_ev=False, has_pv=True, pv_kwp=10.0,
             has_battery=True, battery_kwh=10.0, has_wallbox=False, heating="Gas"),
    ]
    return pd.DataFrame([{**base, **r} for r in rows])


def _pred(test, overrides):
    pred = pd.DataFrame({"has_pv": test.has_pv, "pv_kwp": test.pv_kwp, "has_battery": test.has_battery,
                         "battery_kwh": test.battery_kwh, "has_wallbox": test.has_wallbox, "heatpump_kw": 0.0,
                         "offer_type": test.offer_type}, index=test.index)
    for pid, cols in overrides.items():
        for c, v in cols.items():
            pred.loc[test.project_id == pid, c] = v
    return pred


LABELS = pd.DataFrame({"project_id": ["g1", "p1"], "heatpump_kw": [10.5, np.nan]})


def test_close_rules():
    assert _close(9, 10, False, 9.8, 7.5, False)
    assert not _close(9, 10, False, 10.5, 10, False)       # PV 1.5 kWp off
    assert not _close(9, 10, True, 9, 10, False)           # wallbox differs
    assert not _close(0, 5, False, 6, 5, False)            # engine proposes new PV for a retrofit
    assert _close(0, np.nan, False, None, 0, False)        # NaN / None mean "none"


def test_picks_close_cases_and_skips_far_ones():
    t = _test_table()
    picks = pick_reality(t, LABELS, _pred(t, {"p1": {"pv_kwp": 13.0}}))
    by_role = {p["role"]: p["project_id"] for p in picks}
    assert by_role == {"typical_pv_battery": "p2", "ev_wallbox": "e1", "battery_retrofit": "r1"}


def test_live_check_and_heatpump_fallback():
    t = _test_table()
    live = lambda pid: dict(pv_kwp=6.0 if pid == "r1" else float(t.set_index("project_id").pv_kwp[pid]),
                            battery_kwh=float(t.set_index("project_id").battery_kwh[pid]),
                            wallbox=bool(t.set_index("project_id").has_wallbox[pid]), heatpump_kw=0.0, offer_type=None)
    picks = pick_reality(t, LABELS, _pred(t, {}), live)
    roles = [p["role"] for p in picks]
    assert "battery_retrofit" not in roles                  # the live design proposes new PV for r1
    assert roles[-1] == "heatpump_option" and picks[-1]["project_id"] == "g1"
    assert len(picks) == 3
    assert all(p["ours_live"] is not None for p in picks)


def test_large_home_fallback_when_no_retrofit_or_heatpump():
    t = _test_table()
    t = pd.concat([t, pd.DataFrame([dict(project_id="L1", offer_type="new_system", annual_kwh=9000, has_ev=False,
                                         has_pv=True, pv_kwp=14.0, has_battery=True, battery_kwh=12.0, has_wallbox=False,
                                         consumption_known=True, demand_is_default=False, has_heatpump=False,
                                         heating="Electric")])], ignore_index=True)
    picks = pick_reality(t, LABELS, _pred(t, {"r1": {"pv_kwp": 8.0}, "g1": {"pv_kwp": 14.0}}))
    assert [p["role"] for p in picks] == ["typical_pv_battery", "ev_wallbox", "large_home"]
    assert picks[-1]["project_id"] == "L1"


def test_live_design_asks_for_the_unanswered_project(monkeypatch):
    """Called in-process, /project's FastAPI Query(False) default is truthy: live_design must pass answered=False."""
    from engine import api
    from engine.demo_set import live_design

    seen = {}

    def fake_project(project_id, answered=object()):
        seen["answered"] = answered
        return {"ours": {"design": {"pv": {"kwp": 9.0}, "battery": {"kwh": 10.0}, "wallbox": {"include": False},
                                    "heatpump": {"kw": None}}, "facts_for_explanation": {"offer_type": "pv"}}}

    monkeypatch.setattr(api, "project", fake_project)
    assert live_design("x") == dict(pv_kwp=9.0, battery_kwh=10.0, wallbox=False, heatpump_kw=0.0, offer_type="pv")
    assert seen["answered"] is False
