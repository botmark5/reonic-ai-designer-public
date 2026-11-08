from pathlib import Path

import math
import pytest

from engine.label_rules.items import RAW_NUM_COLS, load_raw, make_items

RAW_DIR = Path(__file__).resolve().parents[2] / "data" / "raw"
needs_data = pytest.mark.skipif(not RAW_DIR.exists(), reason="raw Reonic data not present")


def test_make_items_defaults():
    items = make_items([{"name": "Battery 7kWh", "type": "BatteryStorage", "inverter_power_kw": 7000}])
    row = items.iloc[0]
    assert row.component_name == "Battery 7kWh"
    assert row.component_type == "BatteryStorage"
    assert row.quantity == 1.0
    assert row.technology == "solar"
    assert row.component_brand == ""
    assert math.isnan(row.module_watt_peak)
    assert row.inverter_power_kw == 7000.0


def test_make_items_has_all_raw_numeric_columns_as_float():
    items = make_items([{"name": "Install Wallbox", "type": "InstallationFee", "tech": "wallbox", "qty": 2}])
    for col in RAW_NUM_COLS:
        assert items[col].dtype == float, col
    assert items.iloc[0].technology == "wallbox"
    assert items.iloc[0].quantity == 2.0


@needs_data
def test_load_raw_blank_numeric_is_nan():
    parts, _ = load_raw(RAW_DIR)
    for col in RAW_NUM_COLS:
        assert parts[col].dtype == float, col
    assert parts.quantity.isna().sum() == 0
    assert (parts.component_brand == "").sum() > 0  # blanks are "", not NaN


@needs_data
def test_load_raw_counts():
    parts, sq = load_raw(RAW_DIR)
    assert parts.groupby("installer").size().to_dict() == {"installer_b": 2395, "installer_a": 19257}
    assert sq.groupby("installer").size().to_dict() == {"installer_b": 342, "installer_a": 1277}


def test_blank_numeric_string_becomes_nan_not_zero():
    items = make_items([{"name": "Battery", "type": "BatteryStorage", "inverter_power_kw": "", "module_watt_peak": " "}])
    assert math.isnan(items.iloc[0].inverter_power_kw)
    assert math.isnan(items.iloc[0].module_watt_peak)


@needs_data
def test_real_blank_wattage_is_nan_not_zero():
    parts, _ = load_raw(RAW_DIR)
    assert parts.module_watt_peak.isna().any()
    assert not (parts.module_watt_peak == 0).any()
