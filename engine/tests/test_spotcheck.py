"""Spot-check report: synthetic frames only, no raw data."""
import pandas as pd

from engine.label_rules.items import make_items
from engine.spotcheck import render_spotcheck, sample_projects


def _design(installer, pid, opt, primary, pv, battery_kwh, **extra):
    row = {
        "installer": installer, "project_id": pid, "option_number": opt, "is_primary": primary,
        "offer_type": "full", "is_full_design": True,
        "pv_kwp": pv, "pv_panels": round(pv * 1000 / 450), "pv_source": "module_items",
        "pv_sources_disagree": False, "battery_kwh": battery_kwh, "battery_source": "item" if battery_kwh else "none",
        "wallbox": True, "wallbox_kw": 11.0, "n_wallboxes": 1, "heatpump": False, "heatpump_kw": float("nan"),
        "inverter_kw": 10.0, "roof_type": "tile", "roof_mixed": False, "has_scaffolding": True, "has_backup": False,
        "brand": "Acme", "is_outlier": False, "is_duplicate_option": False,
        "annual_kwh_raw": 4200.0, "consumption_known": True, "has_ev": False,
        "existing_pv_kwp": 0.0, "existing_battery_kwh": 0.0,
        "pv_wp_assumed": float("nan"), "demand_is_default": False, "demand_is_invalid": False,
    }
    row.update(extra)
    return row


def _frames():
    designs = pd.DataFrame([
        _design("installer_a", "projAAAA", 1, True, 8.55, 9.0),
        _design("installer_a", "projAAAA", 2, False, 6.3, 0.0),
        _design("installer_b", "projBBBB", 1, False, 12.15, 7.7),
        _design("installer_b", "projBBBB", 2, True, 4.05, 0.0, consumption_known=False, demand_is_default=True, is_outlier=True),
    ])
    items = []
    for inst, pid, opt in [("installer_a", "projAAAA", 1), ("installer_a", "projAAAA", 2),
                           ("installer_b", "projBBBB", 1), ("installer_b", "projBBBB", 2)]:
        part = make_items([
            {"name": "Trina 450 Wp", "type": "Module", "brand": "Trina", "qty": 19, "module_watt_peak": 450},
            {"name": "BYD 9 kWh", "type": "BatteryStorage", "qty": 1, "inverter_power_kw": 9000},
            {"name": "Inv 10", "type": "Inverter", "qty": 1, "battery_capacity_kwh": 10000},
            {"name": "Wallbox 11", "type": "Wallbox", "qty": 1, "wb_charging_speed_kw": 11000},
            {"name": "Montage", "type": "InstallationFee", "qty": 1},
        ])
        part.insert(0, "installer", inst)
        part["project_id"] = pid
        part["option_number"] = opt
        items.append(part)
    return designs, pd.concat(items, ignore_index=True)


def test_report_has_projects_options_and_pv():
    designs, parts = _frames()
    md = render_spotcheck(designs, parts, n=2, seed=42)
    for needle in ["projAAAA", "projBBBB", "8.55", "6.3", "12.15", "4.05", "Option 1", "Option 2"]:
        assert needle in md
    assert "Trina 450 Wp" in md and "module 450 W" in md
    assert "battery 9000 Wh" in md and "inverter 10000 W" in md and "wallbox 11000 W" in md
    assert "default" in md  # consumption_known False on projBBBB
    assert "primary" in md.lower()


def test_primary_option_listed_first():
    designs, parts = _frames()
    md = render_spotcheck(designs, parts, n=2, seed=42)
    b = md[md.index("projBBBB"):]
    assert b.index("Option 2") < b.index("Option 1")


def test_same_seed_identical_output():
    designs, parts = _frames()
    assert render_spotcheck(designs, parts, n=2, seed=42) == render_spotcheck(designs, parts, n=2, seed=42)


def test_sample_is_stratified_and_deterministic():
    rows = [_design("installer_a", f"a{i}", 1, True, 5.0, 0.0) for i in range(30)]
    rows += [_design("installer_b", f"b{i}", 1, True, 5.0, 0.0) for i in range(10)]
    designs = pd.DataFrame(rows)
    s = sample_projects(designs, n=20, seed=42)
    assert len(s) == 20 and len(set(s)) == 20
    assert sum(p.startswith("a") for p in s) == 15 and sum(p.startswith("b") for p in s) == 5
    assert s == sample_projects(designs, n=20, seed=42)
    small = sample_projects(designs, n=2, seed=42)
    assert {p[0] for p in small} == {"a", "b"}


def _render_one(**extra):
    designs = pd.DataFrame([_design("installer_a", "projCCCC", 1, True, 0.0, 0.0, **extra)])
    parts = make_items([{"name": "Wallbox 11", "type": "Wallbox", "wb_charging_speed_kw": 11000}])
    parts.insert(0, "installer", "installer_a")
    parts["project_id"], parts["option_number"] = "projCCCC", 1
    return render_spotcheck(designs, parts, n=1, seed=42)


def test_nan_pv_wp_assumed_is_not_a_flag():
    md = _render_one()
    assert "pv_wp_assumed" not in md and "assumed" not in md


def test_assumed_panel_wattage_shown_in_pv_part():
    md = _render_one(pv_kwp=8.55, pv_panels=19, pv_wp_assumed=450.0)
    assert "19 panels @ 450 W assumed" in md
    assert "pv_wp_assumed" not in md


def test_nan_bools_render_as_no():
    md = _render_one(wallbox=float("nan"), heatpump=float("nan"), has_scaffolding=float("nan"), has_ev=float("nan"),
                     is_outlier=float("nan"))
    assert "wallbox no" in md and "heat pump no" in md and "scaffolding no" in md and "EV no" in md
    assert "flags" not in md


def test_consumption_markers():
    assert "(default)" in _render_one(consumption_known=False, demand_is_default=True)
    md = _render_one(consumption_known=False, demand_is_invalid=True, annual_kwh_raw=1.0)
    assert "(invalid)" in md and "(default)" not in md
    md = _render_one()
    assert "(default)" not in md and "(invalid)" not in md
