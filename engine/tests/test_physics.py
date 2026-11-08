"""Tests for engine/physics.py: energy balance, plausibility, calibration, edge cases."""
import math

import numpy as np
import pytest

from engine import physics as P
from engine.physics import Home, System, economics, heatpump_recommendation, heatpump_size_kw, sanity_flags, simulate


def codes(flags):
    return {f["code"] for f in flags}


# ---------------------------------------------------------------- energy balance + determinism
@pytest.mark.parametrize("kwh,kwp,bat", [(4500, 5, 0), (4500, 10, 10), (3000, 0, 5), (8000, 15, 0)])
def test_energy_balance(kwh, kwp, bat):
    r = simulate(Home(kwh), System(kwp, bat))
    # every PV kWh is either used in the home, fed in, or lost in the battery
    assert r.yield_kwh == pytest.approx(r.self_used_kwh + r.feed_in_kwh + r.battery_losses_kwh, rel=1e-6, abs=0.5)
    # every consumed kWh comes from PV (direct or battery) or from the grid
    assert r.load_kwh == pytest.approx(r.self_used_kwh + r.grid_import_kwh, rel=1e-6)
    assert 0 <= r.self_consumption <= 1 and 0 <= r.autarky <= 1


def test_annual_totals_exact():
    r = simulate(Home(4500, has_ev=True, ev_km_year=10000), System(9.5, 0))
    assert r.household_kwh == 4500
    assert r.ev_kwh == pytest.approx(10000 / 100 * 18)
    assert r.load_kwh == pytest.approx(4500 + 1800)
    assert r.yield_kwh == pytest.approx(9.5 * 950)


def test_deterministic_with_seed():
    a = simulate(Home(5000), System(8, 10), seed=1)
    b = simulate(Home(5000), System(8, 10), seed=1)
    c = simulate(Home(5000), System(8, 10), seed=2)
    assert a.autarky == b.autarky
    assert a.autarky != c.autarky
    assert abs(a.autarky - c.autarky) < 0.05          # weather seed changes details, not the picture


# ---------------------------------------------------------------- monotonic behaviour
def test_more_battery_never_lowers_autarky():
    vals = [simulate(Home(4500), System(8, b)).autarky for b in (0, 3, 5, 7, 10, 15, 20)]
    assert all(x <= y + 1e-9 for x, y in zip(vals, vals[1:]))


def test_battery_has_diminishing_returns():
    a0, a5, a10, a20 = (simulate(Home(4500), System(8, b)).autarky for b in (0, 5, 10, 20))
    assert (a5 - a0) > (a10 - a5) > (a20 - a10) >= 0


def test_more_pv_lowers_self_consumption_raises_autarky():
    rs = [simulate(Home(4500), System(k, 0)) for k in (3, 6, 9, 12)]
    assert all(a.self_consumption >= b.self_consumption for a, b in zip(rs, rs[1:]))
    assert all(a.autarky <= b.autarky for a, b in zip(rs, rs[1:]))


# ---------------------------------------------------------------- PV yield
def test_yield_by_orientation():
    south, _ = P.pv_specific_yield(180, 30)
    east, _ = P.pv_specific_yield(90, 30)
    west, _ = P.pv_specific_yield(270, 30)
    north, _ = P.pv_specific_yield(0, 30)
    assert south == pytest.approx(950)
    assert east == pytest.approx(west)
    assert north < east < south


def test_yield_missing_orientation_assumes_south_and_says_so():
    y, notes = P.pv_specific_yield(None, None)
    assert y == pytest.approx(950)
    assert any("south" in n for n in notes) and any("tilt" in n for n in notes)


def test_east_roof_shifts_production_earlier():
    east = P._pv_unit_profile(90.0, 42).reshape(365, 24).sum(axis=0)
    west = P._pv_unit_profile(270.0, 42).reshape(365, 24).sum(axis=0)
    hours = np.arange(24)
    assert (east * hours).sum() / east.sum() < (west * hours).sum() / west.sum()


def test_pv_seasonality():
    prof = P._pv_unit_profile(180.0, 42).reshape(365, 24).sum(axis=1)
    assert prof[:31].sum() < 0.05 and prof[181:212].sum() > 0.11      # January small, July big (PVGIS: 4.1 % / 11.9 %)


# ---------------------------------------------------------------- load profiles
def test_home_office_uses_more_pv_than_full_time_worker():
    sc = {p: simulate(Home(4500, load_profile=p), System(8, 0)).self_consumption
          for p in ("H0", "HomeOfficeOnePerson", "FullTimeOnePerson")}
    assert sc["FullTimeOnePerson"] < sc["H0"] < sc["HomeOfficeOnePerson"]


@pytest.mark.parametrize("profile", ["CustomFromEditor", "SomethingNew", None])
def test_unknown_profile_falls_back_to_h0(profile):
    r = simulate(Home(4500, load_profile=profile), System(8, 0))
    h0 = simulate(Home(4500), System(8, 0))
    assert r.self_consumption == pytest.approx(h0.self_consumption)
    assert any("H0" in a for a in r.assumptions)


def test_solar_ev_charging_beats_evening_charging():
    ev = dict(has_ev=True, ev_km_year=15000)
    evening = simulate(Home(4500, **ev), System(10, 0))
    solar = simulate(Home(4500, ev_charging="solar", **ev), System(10, 0))
    assert solar.self_consumption > evening.self_consumption


def test_ev_without_distance_uses_default_and_notes_it():
    r = simulate(Home(4500, has_ev=True), System(8, 0))
    assert r.ev_kwh == pytest.approx(P.EV_DEFAULT_KM / 100 * 18)
    assert any("EV distance unknown" in a for a in r.assumptions)


# ---------------------------------------------------------------- calibration (German rules of thumb)
def test_calibration_pv_only():
    r = simulate(Home(4500), System(5, 0))
    assert 0.25 <= r.self_consumption <= 0.40
    assert 0.25 <= r.autarky <= 0.40


def test_calibration_with_battery():
    assert 0.50 <= simulate(Home(4500), System(5, 5)).autarky <= 0.65
    assert 0.70 <= simulate(Home(4500), System(10, 10)).autarky <= 0.85


def test_battery_cycles_plausible():
    r = simulate(Home(4500), System(8, 8))
    assert 150 <= r.battery_cycles <= 320


# ---------------------------------------------------------------- heat pump
@pytest.mark.parametrize("demand,expected", [(12000, 5.5), (17000, 7.5), (20000, 8.0), (24500, 10.5), (30000, 12.5), (60000, 12.5)])
def test_heatpump_size_snaps_to_catalogue(demand, expected):
    kw, note = heatpump_size_kw(demand)
    assert kw == expected and "kW" in note


def test_heatpump_size_huge_demand_warns():
    _, note = heatpump_size_kw(60000)
    assert "largest catalogue size" in note


@pytest.mark.parametrize("demand", [None, float("nan")])
def test_heatpump_size_missing_demand(demand):
    kw, note = heatpump_size_kw(demand)
    assert kw is None and "unknown" in note


def test_heatpump_rule():
    assert heatpump_recommendation("Gas", 20000)["include"] is True
    assert heatpump_recommendation("Gas", 20000)["kw"] == 8.0          # 20,000 / 2,450 h = 8.2 kW -> the 8 kW model sold
    assert heatpump_recommendation("Heatpump", 20000)["include"] is False
    assert heatpump_recommendation(None, 20000)["include"] is False
    assert heatpump_recommendation("Oil", 20000, installer_sells_heatpumps=False)["include"] is False
    unknown = heatpump_recommendation("Oil", None)
    assert unknown["include"] is True and unknown["kw"] is None


def test_heatpump_adds_heat_demand_over_scop():
    r = simulate(Home(4500, heating="Gas", heating_demand_kwh=21000), System(10, 10, heatpump_kw=7))
    assert r.heatpump_kwh == pytest.approx(21000 / 3.5)
    assert r.load_kwh == pytest.approx(4500 + 6000)


def test_heatpump_load_is_winter_heavy():
    prof = P._heating_unit_profile().reshape(365, 24).sum(axis=1)
    assert prof[:31].sum() > 4 * prof[181:212].sum()


# ---------------------------------------------------------------- economics
def test_economics_payback_plausible():
    e = economics(Home(4500, price_eur_kwh=0.35), System(10, 10))
    assert e["capex_total_eur"] > 0
    assert 5 < e["payback_years"] < 20
    assert e["savings_first_year_eur"] == pytest.approx(sum(e["savings_breakdown_eur"].values()))


def test_economics_nothing_installed():
    e = economics(Home(4500), System(0, 0))
    assert e["capex_total_eur"] == 0 and e["payback_years"] == 0 and e["savings_first_year_eur"] == 0


def test_economics_no_savings_gives_no_payback():
    # wallbox only: costs money, saves nothing in this model
    e = economics(Home(4500), System(0, 0, wallbox=True))
    assert e["payback_years"] is None


def test_economics_uses_default_price_and_says_so():
    e = economics(Home(4500), System(8, 0))
    assert e["price_eur_kwh"] == P.load_economics_config()["electricity"]["default_price_eur_kwh"]
    assert any("price unknown" in a for a in e["assumptions"])


def test_economics_heat_pump_saves_against_gas():
    e = economics(Home(4500, price_eur_kwh=0.30, heating="Gas", heating_demand_kwh=20000), System(10, 10, 7))
    assert e["savings_breakdown_eur"]["heating"] > 0


def test_economics_config_override():
    cfg = P.load_economics_config()
    cfg["electricity"]["feed_in_tariff_eur_kwh"] = 0.0
    e = economics(Home(4500, price_eur_kwh=0.35), System(10, 0), config=cfg)
    assert e["savings_breakdown_eur"]["feed_in"] == 0


# ---------------------------------------------------------------- sanity flags
def test_flags_clean_design_has_no_warnings():
    flags = sanity_flags(Home(4500), System(8, 8))
    assert not [f for f in flags if f["level"] in ("warn", "error")]


def test_flags_fire():
    assert "PV_OVERSIZED" in codes(sanity_flags(Home(4500), System(20, 0)))         # 4.2x: above ~p96 of expert designs
    assert "PV_VERY_OVERSIZED" in codes(sanity_flags(Home(2000), System(15, 0)))    # 7.1x
    # calibrated on expert practice: a 4,500 kWh home with 11 kWp (2.3x) and a 1,600 kWh home with the experts' own
    # 6-7 kWp (3.6-4.2x) are what these installers sell, so neither is "implausible" (issue #66)
    assert not {"PV_OVERSIZED", "PV_VERY_OVERSIZED"} & codes(sanity_flags(Home(4500), System(11, 0)))
    assert "PV_MOSTLY_FED_IN" in codes(sanity_flags(Home(4500), System(13, 0)))
    assert "PV_VERY_OVERSIZED" not in codes(sanity_flags(Home(1600), System(7.2, 9.2)))
    assert "BATTERY_TOO_BIG_FOR_PV" in codes(sanity_flags(Home(4500), System(5, 15)))
    assert "BATTERY_TOO_BIG_FOR_PV" not in codes(sanity_flags(Home(4500), System(6, 10)))   # 1.7 kWh/kWp: p95 of experts
    assert "BATTERY_WITHOUT_PV" in codes(sanity_flags(Home(4500), System(0, 10)))
    assert "BATTERY_WITHOUT_PV" not in codes(sanity_flags(Home(4500, existing_pv_kwp=8), System(0, 10)))
    assert "BATTERY_EXCEEDS_DAILY_USE" in codes(sanity_flags(Home(2000), System(20, 25)))
    assert "WALLBOX_WITHOUT_EV" in codes(sanity_flags(Home(4500), System(8, 8, wallbox=True)))
    assert "EV_WITHOUT_WALLBOX" in codes(sanity_flags(Home(4500, has_ev=True), System(8, 8)))
    assert "HEATPUMP_EXISTING" in codes(sanity_flags(Home(4500, heating="Heatpump", heating_demand_kwh=20000), System(8, 8, 7)))
    assert "HEATPUMP_SIZE_MISMATCH" in codes(sanity_flags(Home(4500, heating="Gas", heating_demand_kwh=12000), System(8, 8, 12)))
    assert "HEATPUMP_DEMAND_UNKNOWN" in codes(sanity_flags(Home(4500, heating="Gas"), System(8, 8, 7)))
    assert "PV_VERY_LARGE" in codes(sanity_flags(Home(30000), System(40, 20)))
    assert "PV_TINY" in codes(sanity_flags(Home(4500), System(0.9, 0)))


def test_flags_have_api_shape():
    for f in sanity_flags(Home(2000), System(15, 30, wallbox=True)):
        assert set(f) == {"component", "level", "code", "message"}
        assert f["level"] in ("info", "warn", "error")


# ---------------------------------------------------------------- edge cases
def test_zero_demand():
    r = simulate(Home(0), System(8, 10))
    assert r.load_kwh == 0 and r.autarky == 0 and r.self_consumption == 0
    assert r.feed_in_kwh + r.battery_losses_kwh == pytest.approx(r.yield_kwh)   # battery fills once, then all PV is fed in
    assert "DEMAND_ZERO" in codes(sanity_flags(Home(0), System(8, 10)))


def test_zero_pv_zero_battery():
    r = simulate(Home(4500), System(0, 0))
    assert r.yield_kwh == 0 and r.self_consumption == 0 and r.autarky == 0
    assert r.grid_import_kwh == pytest.approx(4500)


def test_huge_system_does_not_crash():
    r = simulate(Home(50000, has_ev=True, ev_km_year=60000), System(100, 100, heatpump_kw=12, wallbox=True))
    assert all(math.isfinite(v) for v in (r.yield_kwh, r.autarky, r.self_consumption, r.battery_cycles))
    e = economics(Home(50000), System(100, 100))
    assert math.isfinite(e["capex_total_eur"])


def test_missing_optional_fields_use_defaults():
    r = simulate(Home(4500, load_profile=None, ev_km_year=None, heating=None, orientation_deg=None), System(8, 5))
    assert r.assumptions                                  # every default is reported
    assert math.isfinite(r.autarky)


def test_heatpump_without_heating_demand_estimates_it():
    r = simulate(Home(4500, heating="Gas"), System(8, 5, heatpump_kw=10))
    assert r.heatpump_kwh == pytest.approx(10 * P.HP_FULL_LOAD_HOURS / P.HP_SCOP)
    assert any("Heating demand unknown" in a for a in r.assumptions)


@pytest.mark.parametrize("home,system", [
    (Home(-1), System(5, 0)), (Home(4500), System(-5, 0)), (Home(4500), System(5, -1)),
    (Home(4500, ev_km_year=-100, has_ev=True), System(5, 0)), (Home(float("inf")), System(5, 0)),
])
def test_negative_or_infinite_input_raises(home, system):
    with pytest.raises(ValueError):
        simulate(home, system)


def test_missing_demand():
    with pytest.raises(ValueError, match="annual_kwh"):
        simulate(Home(None), System(5, 0))
    assert codes(sanity_flags(Home(None), System(5, 0))) == {"DEMAND_MISSING"}
    assert codes(sanity_flags(Home(4500), System(-1, 0))) == {"NEGATIVE_INPUT"}
