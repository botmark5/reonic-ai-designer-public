"""PV size (R1), roof type (R6) and scaffolding (R7) rules. One test per example row of docs/labels-rules.md."""
import math

import pytest

from engine.label_rules.items import make_items
from engine.label_rules.pv import extract_pv, extract_roof_type, has_scaffolding

INST_B = "installer_b"
INST_A = "installer_a"


def sub(name, qty=1.0):
    return {"name": name, "type": "ModuleFrameConstruction", "qty": qty}


def dc(name, qty=1.0):
    return {"name": name, "type": "AccessoryToModule", "qty": qty}


def roof_mounting(name, qty=1.0):
    return {"name": name, "type": "InstallationFee", "qty": qty}


def module(name, qty, wp):
    return {"name": name, "type": "Module", "qty": qty, "module_watt_peak": wp}


def pkg_a(name):
    return {"name": name, "type": "ServiceFee"}


def pkg_b(name):
    return {"name": name, "type": "Other"}


def pv(rows, installer):
    return extract_pv(make_items(rows), installer)


def assert_pv(result, kwp, panels, source, wp_assumed, disagree):
    assert result["pv_kwp"] == pytest.approx(kwp)
    if math.isnan(panels):
        assert math.isnan(result["pv_panels"])
    else:
        assert result["pv_panels"] == pytest.approx(panels)
    assert result["pv_source"] == source
    if math.isnan(wp_assumed):
        assert math.isnan(result["pv_wp_assumed"])
    else:
        assert result["pv_wp_assumed"] == wp_assumed
    assert result["pv_sources_disagree"] is disagree


NAN = float("nan")


# --- R1, installer_a -------------------------------------------------------------------------------

def test_r1_01_standard_case_scaffolding_quantity_is_ignored():
    rows = [
        sub("Substructure Concrete Roof", 19),
        dc("DC Install Concrete Roof", 19),
        {"name": "Optimizer", "qty": 19},
        {"name": "Scaffolding Setup & Removal", "type": "ModuleFrameConstruction", "qty": 19},
    ]
    assert_pv(pv(rows, INST_A), 8.55, 19, "substructure", 450.0, False)


def test_r1_02_substructure_kit_uses_dc_install():
    rows = [sub("Substructure Concrete Tile Roof", 1), dc("DC Install Concrete Tile Roof", 13), {"name": "Optimizer", "qty": 13}]
    assert_pv(pv(rows, INST_A), 5.85, 13, "substructure", 450.0, True)


def test_r1_03_substructure_wins_over_dc_install_kit():
    rows = [sub("Substructure Concrete Tile Roof", 30), dc("DC Install Concrete Tile Roof", 1)]
    assert_pv(pv(rows, INST_A), 13.5, 30, "substructure", 450.0, True)


def test_r1_04_substructure_wins_over_dc_install_sum():
    rows = [sub("Substructure Slate Roof", 18), dc("DC Install Slate Roof", 9), dc("DC Install Concrete Tile Roof", 12)]
    assert_pv(pv(rows, INST_A), 8.1, 18, "substructure", 450.0, True)


def test_r1_05_substructure_is_summed_over_roof_types():
    rows = [sub("Substructure Clay Tile Roof", 2), sub("Substructure Flat Roof East/West", 4)]
    assert_pv(pv(rows, INST_A), 2.7, 6, "substructure", 450.0, False)


def test_r1_06_package_name_fallback_has_no_panel_count():
    rows = [pkg_a("PV Complete Package 5kW")]
    assert_pv(pv(rows, INST_A), 5.0, NAN, "package_name", NAN, False)


def test_r1_07_per_panel_count_beats_a_package_name():
    rows = [pkg_a("PV Complete Package 8kW"), dc("DC Install Concrete Tile Roof", 20), {"name": "Optimizer", "qty": 20}]
    assert_pv(pv(rows, INST_A), 9.0, 20, "substructure", 450.0, True)


def test_r1_08_known_module_wattage_is_not_assumed():
    rows = [module("PV Module 475W", 5, 475.0), sub("Substructure Concrete Tile Roof", 5)]
    assert_pv(pv(rows, INST_A), 2.375, 5, "module_lines", NAN, False)


def test_r1_09_solar_tagged_fees_only_is_zero():
    rows = [{"name": "Meter Consolidation B"}, {"name": "Travel – Extension"}]
    assert_pv(pv(rows, INST_A), 0.0, NAN, "none", NAN, False)


# --- R1, installer_b -------------------------------------------------------------------------------

def test_r1_10_package_beats_roof_mounting_count():
    rows = [
        pkg_b("Complete Package 2 Voltara 10.8kWp + 9kWh B"),
        roof_mounting("Roof Mounting 8.8-15kWp", 26),
        sub("Substructure 8.8-15kWp", 26),
    ]
    assert_pv(pv(rows, INST_B), 10.8, 24, "package_name", NAN, True)


def test_r1_11_module_lines_are_the_total_when_planner_upsized():
    rows = [
        pkg_b("Complete Package 2 Voltara 10.8kWp + 9kWh B"),
        module("PV Module 463W Glass Bonus", 27, 450.0),
        {"name": "Additional Module incl. Substructure + Mounting", "type": "Other", "qty": 3},
    ]
    # package 24 panels + the 3 named extras = 27 panels = the module lines, so no source disagrees
    assert_pv(pv(rows, INST_B), 12.15, 27, "module_lines", NAN, False)


def test_r1_12_module_lines_are_the_total_when_planner_downsized():
    rows = [pkg_b("Complete Package 4 Voltara 18kWp + 9kWh B"), module("PV Module 463W Glass Bonus", 16, 450.0)]
    assert_pv(pv(rows, INST_B), 7.2, 16, "module_lines", NAN, True)


def test_r1_13_single_module_is_an_extra_on_top_of_the_package():
    rows = [pkg_b("Complete Package 3 Voltara 13.5kWp + 9kWh C"), module("PV Module 480W Glass Bonus", 1, 475.0)]
    assert_pv(pv(rows, INST_B), 13.975, 31, "module_lines", NAN, True)


def test_r1_14_module_qty_equal_to_package_plus_named_extras():
    rows = [
        pkg_b("Complete Package 2 Voltara 10.8kWp + 9kWh B"),
        module("PV Module 480W Glass Bonus", 24, 475.0),
        pkg_b("3x Extra PV Module 480W"),
        roof_mounting("Roof Mounting 8.8-15kWp", 3),
    ]
    assert_pv(pv(rows, INST_B), 12.825, 27, "module_lines", NAN, True)


def test_r1_15_named_extras_without_module_lines():
    rows = [pkg_b("Complete Package 1 Gridwell 6.3kWp + 5kWh"), pkg_b("4 Additional Modules (beyond Package)")]
    assert_pv(pv(rows, INST_B), 8.1, 18, "package_name", NAN, False)


def test_r1_16_roof_mounting_count_when_substructure_is_a_kit():
    rows = [sub("Substructure 15-30kWp", 1), roof_mounting("Roof Mounting 15-20kWp", 35), {"name": "Micro Inverter 2000W", "qty": 1}]
    assert_pv(pv(rows, INST_B), 15.75, 35, "roof_mounting", 450.0, False)


def test_r1_17_only_the_size_band_is_known():
    rows = [roof_mounting("Roof Mounting 6-8.8kWp", 1), sub("Substructure 6-8.8kWp", 1)]
    assert_pv(pv(rows, INST_B), 7.4, NAN, "size_band", NAN, False)


def test_r1_18_commercial_module_lines():
    rows = [module("PV Module 463W Glass Bonus", 222, 450.0)]
    assert_pv(pv(rows, INST_B), 99.9, 222, "module_lines", NAN, False)


# --- R1, review focus -------------------------------------------------------------------------------

def test_substructure_band_name_with_count_is_a_count_never_a_package_size():
    rows = [sub("Substructure 8.8-15kWp", 26)]
    assert_pv(pv(rows, INST_B), 11.7, 26, "substructure", 450.0, False)


def test_complete_package_without_kwp_is_not_a_size():
    rows = [pkg_b("Complete Package Price")]
    assert_pv(pv(rows, INST_B), 0.0, NAN, "none", NAN, False)


def test_few_modules_below_half_the_package_are_extras_but_many_are_a_downsize():
    package = pkg_b("Complete Package 2 Voltara 10.8kWp + 9kWh B")
    extra = pv([package, module("PV Module 450W", 2, 450.0)], INST_B)
    assert extra["pv_kwp"] == pytest.approx(11.7)
    downsized = pv([package, module("PV Module 450W", 11, 450.0)], INST_B)
    assert downsized["pv_kwp"] == pytest.approx(4.95)


def test_n_x_pv_module_line_counts_as_a_named_extra():
    rows = [pkg_b("Complete Package 2 Kestrel 10.8kWp + 10kWh"), pkg_b("2x PV Module 450W"), roof_mounting("Roof Mounting 8.8-15kWp", 2)]
    # Roof Mounting 2 is a different count (2 x 450 W), so the sources disagree
    assert_pv(pv(rows, INST_B), 11.7, 26, "package_name", NAN, True)


def test_module_rows_without_wattage_are_not_module_lines():
    rows = [{"name": "PV Module", "type": "Module", "qty": 10}, sub("Substructure Flat Roof", 10)]
    assert_pv(pv(rows, INST_A), 4.5, 10, "substructure", 450.0, False)


def test_surcharge_roof_mounting_is_not_a_panel_count():
    rows = [roof_mounting("Roof Mounting Beaver Tail Tile (Surcharge)", 12), sub("Substructure 8.8-15kWp", 20)]
    assert_pv(pv(rows, INST_B), 9.0, 20, "substructure", 450.0, False)


def test_unknown_installer_is_rejected():
    with pytest.raises(ValueError):
        pv([sub("Substructure Flat Roof", 10)], "ffffffff")


# --- R6 roof type -------------------------------------------------------------------------------

def roof(rows):
    return extract_roof_type(make_items(rows))


@pytest.mark.parametrize(
    "rows, expected",
    [
        ([sub("Substructure Concrete Roof")], "Concrete Tile"),
        ([dc("DC Install Concrete Roof >30°")], "Concrete Tile"),
        ([sub("Substructure Flat Roof East/West")], "Flat"),
        ([sub("Substructure Green Roof PV East/West")], "Flat"),
        ([sub("Substructure Standing Seam B")], "Metal"),
        ([sub("Substructure Bitumen Roof Mounting")], "Bitumen"),
        ([sub("Substructure 8.8-15kWp")], "Unknown"),
        ([sub("Substructure Flat Roof Ballast")], "Flat"),
        ([roof_mounting("Roof Mounting Beaver Tail Tile (Surcharge)")], "Beaver Tail Tile"),
        ([roof_mounting("Roof Mounting Mortared Tiles (Surcharge)")], "Clay Tile"),
        ([sub("Substructure Clay Roof")], "Clay Tile"),
        ([sub("Substructure Slate Roof")], "Slate"),
        ([sub("Substructure Trapezoidal Sheet")], "Metal"),
        ([sub("Substructure Facade Concrete")], "Facade"),
        ([sub("Substructure Cross-Lay 8.8-13kWp")], "Unknown"),
        ([roof_mounting("Roof Mounting Cross-Lay (Surcharge)")], "Unknown"),
        ([sub("Substructure Concrete Tile Roof Rack System")], "Concrete Tile"),
        ([dc("DC Install Clay Roof <30°")], "Clay Tile"),
    ],
)
def test_r6_single_roof_type(rows, expected):
    assert roof(rows) == {"roof_type": expected, "roof_mixed": False}


def test_r6_mixed_roof_takes_the_type_with_most_panels():
    rows = [sub("Substructure Clay Tile Roof", 2), sub("Substructure Flat Roof", 4)]
    assert roof(rows) == {"roof_type": "Flat", "roof_mixed": True}


def test_r6_tie_goes_to_the_alphabetically_first_type():
    rows = [sub("Substructure Metal Roof", 5), sub("Substructure Clay Tile Roof", 5)]
    assert roof(rows) == {"roof_type": "Clay Tile", "roof_mixed": True}


def test_r6_substructure_and_dc_install_of_one_type_are_not_double_counted():
    rows = [sub("Substructure Clay Tile Roof", 10), dc("DC Install Clay Tile Roof", 10), sub("Substructure Flat Roof", 12)]
    assert roof(rows) == {"roof_type": "Flat", "roof_mixed": True}


def test_r6_known_type_beats_unknown_band_substructure():
    rows = [sub("Substructure 8.8-15kWp", 26), roof_mounting("Roof Mounting Beaver Tail Tile (Surcharge)", 10)]
    assert roof(rows) == {"roof_type": "Beaver Tail Tile", "roof_mixed": False}


def test_r6_no_roof_lines_is_unknown():
    assert roof([{"name": "Meter Consolidation B"}]) == {"roof_type": "Unknown", "roof_mixed": False}


def test_r6_accessory_lines_that_mention_tiles_are_not_roof_cover():
    rows = [{"name": "Use of Flat Ventilation Tile"}, {"name": "Black End Caps on Substructure"}, {"name": "Replacement Tiles"}]
    assert roof(rows)["roof_type"] == "Unknown"


# --- R7 scaffolding -------------------------------------------------------------------------------

@pytest.mark.parametrize(
    "name",
    [
        "Scaffolding Setup & Removal",
        "Scaffolding Setup & Removal - Quote",
        "Scaffolding Provided by Customer",
        "Mobile Scaffolding",
        "Site Setup / Safety (up to 5m)",
        "Site Setup / Safety (from 10m)",
    ],
)
def test_r7_scaffolding_lines(name):
    assert has_scaffolding(make_items([{"name": "Substructure Flat Roof"}, {"name": name}])) is True


def test_r7_no_scaffolding_line():
    items = make_items([{"name": "Substructure Flat Roof"}, {"name": "Site Setup Discount (Bundle Offer)"}])
    assert has_scaffolding(items) is False


def test_flat_roof_ballast_is_not_a_panel_count():
    # B option ex47·3 pattern: 10 panels on roof mounting + 10 substructure + one ballast kit line.
    rows = [
        roof_mounting("Roof Mounting 8.8-15kWp", 10),
        sub("Substructure Flat Roof 10-15kWp", 10),
        sub("Substructure Flat Roof Ballast", 1),
    ]
    result = pv(rows, INST_B)
    assert result["pv_panels"] == 10
    assert result["pv_sources_disagree"] is False
