"""Rules R2-R5 and R8 of docs/labels-rules.md: every row of the example tables is one test case.

Raw columns are shifted: BatteryStorage rows carry the battery Wh in `inverter_power_kw`,
Inverter rows carry the inverter W in `battery_capacity_kwh`.
"""
import math

import pytest

from engine.label_rules.components import (
    extract_battery,
    extract_brand,
    extract_heatpump,
    extract_inverter,
    extract_wallbox,
    has_backup,
)
from engine.label_rules.items import make_items


def battery(name, col=None, qty=1.0, brand="", type="BatteryStorage"):
    row = {"name": name, "type": type, "tech": "ses", "brand": brand, "qty": qty}
    if col is not None:
        row["inverter_power_kw"] = col
    return row


def package(name):
    return {"name": name, "type": "Other"}


# ---------------------------------------------------------------- R2 battery

R2_CASES = [
    # id, rows, kwh, source
    ("1 single 7kWh", [battery("Battery 7kWh", 7000)], 7.0, "numeric_column"),
    (
        "2 qty counts, coupler excluded",
        [battery("Battery LFP 15kWh", 15000, qty=2), battery("AC Coupling Module (Free)", 1980)],
        30.0,
        "numeric_column",
    ),
    (
        "3 accessory extension, name only",
        [battery("Battery 5kWh Extension", type="AccessoryToBatteryStorage")],
        5.0,
        "name",
    ),
    (
        "4 lines beat package",
        [package("Complete Package 2 Voltara 18kWp + 9kWh"), battery("Voltara AIO Battery 9kWh", 9000, qty=2)],
        18.0,
        "numeric_column",
    ),
    (
        "5 planner swapped battery",
        [package("Complete Package 2 Voltara 13.5kWp + 9kWh"), battery("Voltara AIO Battery 6kWh", 6000)],
        6.0,
        "numeric_column",
    ),
    (
        "6 sum of rows",
        [
            package("Complete Package 2 Voltara 10.8kWp + 9kWh"),
            battery("Voltara AIO Battery 9kWh", 9000),
            battery("Voltara AIO Battery 6kWh", 6000),
        ],
        15.0,
        "numeric_column",
    ),
    (
        "7 Kestrel L3 column",
        [package("Complete Package 1 Kestrel 10.8kWp + 10kWh"), battery("Kestrel Battery 5kWh L3", 14760)],
        14.76,
        "numeric_column",
    ),
    (
        "8 Kestrel 3.3kWh L3 column",
        [package("Complete Package 1 Kestrel 6.3kWp + 6,6kWh"), battery("Kestrel Battery 3.3kWh L3", 9600)],
        9.6,
        "numeric_column",
    ),
    (
        "9 package fallback",
        [package("Complete Package 2 Voltara 10.8kWp + 9kWh B")],
        9.0,
        "package_name",
    ),
    (
        "10 extended warranty ignored",
        [
            battery("Voltara AIO Battery 9kWh", 9000),
            battery("Voltara Extended Warranty Storage 9kWh", type="AccessoryToBatteryStorage"),
        ],
        9.0,
        "numeric_column",
    ),
    (
        "11 towers ignored",
        [
            battery("Voltara Stack Battery 12kWh", 12000, qty=9),
            battery("Voltara Stack Battery 12kWh Main Tower", type="AccessoryToBatteryStorage"),
            battery("Voltara Stack Battery 12kWh Next Tower", type="AccessoryToBatteryStorage"),
        ],
        108.0,
        "numeric_column",
    ),
    ("12 Flowmax usable column", [battery("Flowmax Battery 5.1kWh", 4800, brand="Flowmax")], 4.8, "numeric_column"),
]


@pytest.mark.parametrize("rows,kwh,source", [c[1:] for c in R2_CASES], ids=[c[0] for c in R2_CASES])
def test_r2_battery_examples(rows, kwh, source):
    out = extract_battery(make_items(rows))
    assert out["battery"] is True
    assert out["battery_kwh"] == pytest.approx(kwh)
    assert out["battery_source"] == source


def test_r2_no_battery():
    out = extract_battery(make_items([{"name": "PV Module 450W", "type": "Module"}]))
    assert out == {"battery": False, "battery_kwh": 0.0, "battery_source": "none"}


def test_r2_empty_items():
    out = extract_battery(make_items([]))
    assert out == {"battery": False, "battery_kwh": 0.0, "battery_source": "none"}


def test_r2_inverter_column_is_never_battery():
    items = make_items([{"name": "Hybrid Inverter 15kW", "type": "Inverter", "battery_capacity_kwh": 15000}])
    out = extract_battery(items)
    assert out["battery_kwh"] == 0.0
    assert out["battery"] is False
    assert out["battery_source"] == "none"


def test_r2_name_fallback_decimal_comma_when_column_empty():
    items = make_items([battery("Flowmax Flowmax | 10,2 kWh | Home Stack / X1", brand="Flowmax")])
    out = extract_battery(items)
    assert out["battery_kwh"] == pytest.approx(10.2)
    assert out["battery_source"] == "name"


def test_r2_name_fallback_multiplies_quantity():
    out = extract_battery(make_items([battery("Battery 5kWh", qty=2)]))
    assert out["battery_kwh"] == pytest.approx(10.0)
    assert out["battery_source"] == "name"


def test_r2_mixed_column_and_name_rows_source_is_numeric_column():
    items = make_items([battery("Battery 10kWh", 10000), battery("Battery 5kWh Extension", type="AccessoryToBatteryStorage")])
    out = extract_battery(items)
    assert out["battery_kwh"] == pytest.approx(15.0)
    assert out["battery_source"] == "numeric_column"


@pytest.mark.parametrize("name", ["Battery Power Module Bonus", "Stack Battery 12kWh Main Tower", "Voltara Extended Warranty Storage 9kWh"])
def test_r2_excluded_names_add_nothing_even_as_battery_rows(name):
    out = extract_battery(make_items([battery(name)]))
    assert out["battery_kwh"] == 0.0
    assert out["battery_source"] == "none"


def test_r2_battery_accessories_without_extension_wording_add_nothing():
    items = make_items([battery("Smart Guard 40A", type="AccessoryToBatteryStorage"), battery("Zigbee Adapter", type="AccessoryToBatteryStorage")])
    assert extract_battery(items)["battery"] is False


# ---------------------------------------------------------------- R3 wallbox


def wallbox(name, col=None, qty=1.0, brand=""):
    row = {"name": name, "type": "Wallbox", "tech": "wallbox", "brand": brand, "qty": qty}
    if col is not None:
        row["wb_charging_speed_kw"] = col
    return row


def fee(name, type="InstallationFee"):
    return {"name": name, "type": type, "tech": "wallbox"}


R3_CASES = [
    # id, rows, wallbox, kw (None = NaN), n
    ("1 plain Wallbox 22 kW", [wallbox("Wallbox", 22000, brand="Huawei")], True, 22.0, 1.0),
    ("2 column beats name", [wallbox("Smart EV Charger 22kW Approved", 11000, brand="SolarEdge")], True, 11.0, 1.0),
    ("3 qty 2", [wallbox("Wallbox", 22000, qty=2)], True, 22.0, 2.0),
    ("4 install fee only", [fee("Install Wallbox")], True, None, 1.0),
    (
        "5 on-site component + install fee",
        [{"name": "Wallbox Component On-Site", "type": "Other"}, fee("Install Wallbox")],
        True,
        None,
        1.0,
    ),
    ("6 prep only", [{"name": "Prep Wallbox", "type": "Other"}], False, None, 0.0),
    (
        "7 all-inclusive package",
        [fee("All-Inclusive Package - Wallbox", type="ServiceFee"), fee("Travel & Logistics Flat Rate - Wallbox", type="ServiceFee")],
        True,
        None,
        1.0,
    ),
    ("8 power boost for existing", [{"name": "Power Boost for Existing Wallbox", "type": "Other"}], False, None, 0.0),
    (
        "9 promo line + wallbox row",
        [{"name": "Winter Promo Free Wallbox with PV", "type": "Other"}, wallbox("Voltara AC Wallbox 11kW", 11000, brand="Voltara")],
        True,
        11.0,
        1.0,
    ),
    ("10 free Flowmax 11kW", [wallbox("Wallbox 11kW Gen2 (Free)", 11000, brand="Flowmax")], True, 11.0, 1.0),
]


@pytest.mark.parametrize("rows,flag,kw,n", [c[1:] for c in R3_CASES], ids=[c[0] for c in R3_CASES])
def test_r3_wallbox_examples(rows, flag, kw, n):
    out = extract_wallbox(make_items(rows))
    assert out["wallbox"] is flag
    if kw is None:
        assert math.isnan(out["wallbox_kw"])
    else:
        assert out["wallbox_kw"] == pytest.approx(kw)
    assert out["n_wallboxes"] == pytest.approx(n)


def test_r3_wallbox_installation_fee_variant_counts():
    assert extract_wallbox(make_items([fee("Wallbox Installation")]))["wallbox"] is True


def test_r3_install_on_site_prep_is_not_a_wallbox():
    assert extract_wallbox(make_items([fee("Install Wallbox - On-Site Prep")]))["wallbox"] is False


def test_r3_several_wallbox_rows_use_max_kw_and_sum_quantity():
    out = extract_wallbox(make_items([wallbox("Wallbox 11kW", 11000), wallbox("Wallbox 22kW Gen2", 22000, qty=2)]))
    assert out["wallbox_kw"] == pytest.approx(22.0)
    assert out["n_wallboxes"] == pytest.approx(3.0)


def test_r3_wallbox_row_without_column_has_nan_kw_but_counts():
    out = extract_wallbox(make_items([wallbox("Wallbox Kit")]))
    assert out["wallbox"] is True
    assert math.isnan(out["wallbox_kw"])
    assert out["n_wallboxes"] == 1.0


def test_r3_free_promo_wallbox_line_alone_counts_with_kw_from_name():
    out = extract_wallbox(make_items([{"name": "Free 11kW Charging Wallbox Promo", "type": "Other"}]))
    assert out["wallbox"] is True
    assert out["wallbox_kw"] == pytest.approx(11.0)
    assert out["n_wallboxes"] == 1.0


def test_r3_ev_charger_other_line_counts_expenses_line_does_not():
    out = extract_wallbox(make_items([{"name": "EV Charger Plus", "type": "Other"},
                                      {"name": "Additional Wallbox Expenses", "type": "Other"}]))
    assert out["wallbox"] is True
    assert math.isnan(out["wallbox_kw"])
    assert out["n_wallboxes"] == 1.0


def test_r3_additional_wallbox_expenses_alone_is_not_a_wallbox():
    out = extract_wallbox(make_items([{"name": "Additional Wallbox Expenses", "type": "Other"}]))
    assert out["wallbox"] is False
    assert out["n_wallboxes"] == 0.0


@pytest.mark.parametrize("name", ["Winter Promo Free Wallbox with PV", "Special Deal Free Wallbox (Limited Time)",
                                  "Autumn Promo Free Wallbox with PV"])
def test_r3_promo_text_next_to_wallbox_row_does_not_double_count(name):
    out = extract_wallbox(make_items([{"name": name, "type": "Other"},
                                      wallbox("Voltara AC Wallbox 11kW", 11000, brand="Voltara")]))
    assert out["n_wallboxes"] == 1.0
    assert out["wallbox_kw"] == pytest.approx(11.0)


@pytest.mark.parametrize("name", ["Power Boost for Existing Wallbox", "Free Wallbox Cable", "Free Wallbox Prep",
                                  "Free Wallbox Subsidy Deadline", "EV Charger Smart Meter", "EV Charger Prep"])
def test_r3_excluded_promo_like_lines_are_not_wallboxes(name):
    assert extract_wallbox(make_items([{"name": name, "type": "Other"}]))["wallbox"] is False


# ---------------------------------------------------------------- R4 heat pump


def heatpump(name, col=None, brand="", qty=1.0):
    row = {"name": name, "type": "Heatpump", "tech": "heatpump", "brand": brand, "qty": qty}
    if col is not None:
        row["heatpump_nominal_power_kw"] = col
    return row


@pytest.mark.parametrize(
    "name,col,brand,kw",
    [
        ("Heat Pump 8kW", 10140, "Aira", 8.0),
        ("Heat Pump 10.5kW 400V", 10000, "Vaillant", 10.5),
        ("Heat Pump 5.5kW 230V", 5000, "Vaillant", 5.5),
        ("Heat Pump 12.5kW 400V", 12000, "Vaillant", 12.5),
        ("Heat Pump 7.5kW 230V", 7000, "Vaillant", 7.5),
    ],
)
def test_r4_kw_from_name_not_column(name, col, brand, kw):
    out = extract_heatpump(make_items([heatpump(name, col, brand)]))
    assert out["heatpump"] is True
    assert out["heatpump_kw"] == pytest.approx(kw)


def test_r4_column_only_when_name_has_no_number():
    out = extract_heatpump(make_items([heatpump("Heat Pump", 9000)]))
    assert out["heatpump_kw"] == pytest.approx(9.0)


def test_r4_no_number_anywhere_is_nan_but_true():
    out = extract_heatpump(make_items([heatpump("Heat Pump")]))
    assert out["heatpump"] is True
    assert math.isnan(out["heatpump_kw"])


def test_r4_no_heatpump_row():
    out = extract_heatpump(make_items([{"name": "Cascading Heat Pump Meters", "type": "InstallationFee"}]))
    assert out["heatpump"] is False
    assert math.isnan(out["heatpump_kw"])


# ---------------------------------------------------------------- R5 inverter


def inverter(name, col=None, qty=1.0, type="Inverter", tech="ses"):
    row = {"name": name, "type": type, "tech": tech, "qty": qty}
    if col is not None:
        row["battery_capacity_kwh"] = col
    return row


@pytest.mark.parametrize(
    "rows,kw",
    [
        ([inverter("Voltara Hybrid Inverter 10kW", 10000)], 10.0),
        ([inverter("Voltara Hybrid Inverter 25kW", 4049)], 25.0),
        ([inverter("Micro Inverter 1000W", type="Other", qty=3)], 3.0),
        ([inverter("Micro Inverter 1600W", type="Other", qty=2)], 3.2),
        ([inverter("Gridwell String Inverter 8kW", type="Other")], 8.0),
        ([inverter("Hybrid Inverter 15kW", 15000, tech="")], 15.0),
        ([inverter("Voltara Hybrid Inverter 10kW Gen2 B"), inverter("Micro Inverter 2000W", type="Other")], 12.0),
    ],
    ids=["10kW", "25kW name beats column", "micro 1000Wx3", "micro 1600Wx2", "string type Other", "technology empty", "sum over rows"],
)
def test_r5_inverter_kw(rows, kw):
    assert extract_inverter(make_items(rows))["inverter_kw"] == pytest.approx(kw)


def test_r5_typical_a_option_without_inverter_row_is_nan():
    items = make_items([{"name": "Install Inverter", "type": "InstallationFee"}, {"name": "Inverter Installation", "type": "AccessoryToInverter"}])
    assert math.isnan(extract_inverter(items)["inverter_kw"])


def test_r5_other_rows_mentioning_inverter_without_size_add_nothing():
    items = make_items([
        {"name": "Discount Bundle + Inverter Difference", "type": "Other"},
        {"name": "Battery Extension Possible with Existing Inverter", "type": "Other"},
    ])
    assert math.isnan(extract_inverter(items)["inverter_kw"])


def test_r5_inverter_row_without_number_in_name_falls_back_to_shifted_column():
    items = make_items([inverter("Hybrid Inverter", 6000)])
    assert extract_inverter(items)["inverter_kw"] == pytest.approx(6.0)


# ---------------------------------------------------------------- R8 brand and backup


def test_r8_brand_from_battery_row_column():
    items = make_items([battery("Battery LFP 10kWh", 10000, brand="Flowmax")])
    assert extract_brand(items) == "Flowmax"


def test_r8_brand_from_first_word_of_name_when_column_empty():
    assert extract_brand(make_items([battery("Gridwell Battery 5kWh B", 5000, brand="")])) == "Gridwell"


def test_r8_wallbox_name_word_when_no_battery_or_inverter():
    assert extract_brand(make_items([wallbox("Kestrel Wallbox 11kW", 11000)])) == "Kestrel"


def test_r8_battery_row_beats_wallbox_row():
    items = make_items([wallbox("Voltara AC Wallbox 11kW", 11000, brand="Voltara"), battery("Flowmax Battery 5.1kWh", 4800, brand="Flowmax")])
    assert extract_brand(items) == "Flowmax"


def test_r8_inverter_beats_wallbox():
    items = make_items([wallbox("Voltara AC Wallbox 11kW", 11000, brand="Voltara"), inverter("Gridwell Hybrid Inverter 10kW", 10000)])
    assert extract_brand(items) == "Gridwell"


def test_r8_package_row_brand_from_column():
    items = make_items([
        {"name": "Complete Package 2 Gridwell 10.8kWp + 10kWh", "type": "Other", "brand": "Gridwell"},
        {"name": "Manual Transfer Switch", "type": "AccessoryToBatteryStorage"},
    ])
    assert extract_brand(items) == "Gridwell"


def test_r8_package_row_brand_from_word_after_package_number_when_column_empty():
    items = make_items([{"name": "Complete Package 3 Kestrel 15.3kWp + 15kWh", "type": "Other", "brand": ""}])
    assert extract_brand(items) == "Kestrel"


def test_r8_battery_row_beats_package_row():
    items = make_items([
        {"name": "Complete Package 1 Gridwell 6.3kWp + 5kWh", "type": "Other", "brand": "Gridwell"},
        battery("Voltara AIO Battery 9kWh", 9000, brand="Voltara"),
    ])
    assert extract_brand(items) == "Voltara"


def test_r8_package_beats_energy_manager():
    items = make_items([
        {"name": "Energy Manager B", "type": "AccessoryToModule", "brand": "Huawei"},
        {"name": "Complete Package 1 Voltara 6.3kWp + 6kWh", "type": "Other", "brand": "Voltara"},
    ])
    assert extract_brand(items) == "Voltara"


def test_r8_package_row_with_never_counting_brand_is_unknown():
    items = make_items([{"name": "Complete Package 1 Sunpro 6.3kWp", "type": "Other", "brand": "Sunpro"}])
    assert extract_brand(items) == "Unknown"


def test_r8_energy_manager_is_last_fallback():
    items = make_items([{"name": "Energy Manager B", "type": "AccessoryToModule", "brand": "Huawei"}, {"name": "PV Module 450W", "type": "Module", "brand": "Trina"}])
    assert extract_brand(items) == "Huawei"


def test_r8_smartfox_wallbox_skipped_until_last_fallback():
    items = make_items([wallbox("Smart Charger Plus", 11000, brand="Smartfox"), {"name": "Energy Manager C", "type": "AccessoryToModule", "brand": "SAJ"}])
    assert extract_brand(items) == "SAJ"


def test_r8_smartfox_energy_manager_counts_at_last_level():
    items = make_items([{"name": "Energy Manager Plus", "type": "AccessoryToModule", "brand": "Smartfox"}])
    assert extract_brand(items) == "Smartfox"


def test_r8_only_insurer_is_unknown():
    items = make_items([{"name": "Optional Yield Cover", "type": "Other", "brand": "Insurer"}])
    assert extract_brand(items) == "Unknown"


@pytest.mark.parametrize("brand", ["Insurer", "Mennekes", "BirdBlocker", "Novotegra", "Braas", "F-Tronic", "Vaillant", "Aira", "Sunpro", "Lynus", "AIKO", "Trina", "SL Rack"])
def test_r8_never_counting_brands(brand):
    items = make_items([{"name": "Some Part", "type": "Other", "brand": brand}, wallbox("Wallbox", 11000, brand=brand)])
    assert extract_brand(items) == "Unknown"


def test_r8_heatpump_brand_does_not_count():
    assert extract_brand(make_items([heatpump("Heat Pump 10.5kW 400V", 10000, brand="Vaillant")])) == "Unknown"


def test_r8_unknown_first_word_does_not_count():
    assert extract_brand(make_items([wallbox("Wallbox Kit", 22000)])) == "Unknown"


def test_r8_empty_items():
    assert extract_brand(make_items([])) == "Unknown"


@pytest.mark.parametrize(
    "name",
    ["Smart Guard 40A", "Backup Box 1-Phase", "Emergency Power Supply", "3-Phase Backup Solution", "Home Backup Interface", "Automatic Transfer Switch", "Manual Transfer Switch"],
)
def test_r8_backup_names(name):
    assert has_backup(make_items([{"name": name, "type": "AccessoryToBatteryStorage"}])) is True


def test_r8_no_backup():
    assert has_backup(make_items([{"name": "Battery 7kWh", "type": "BatteryStorage"}])) is False
    assert has_backup(make_items([])) is False
