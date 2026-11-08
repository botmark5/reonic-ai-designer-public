import numpy as np
import pandas as pd

from engine.label_rules.items import make_items
from engine.label_rules.offer import add_project_columns, classify_offer

PV_BATT = {"pv_kwp": 9.0, "battery_kwh": 10.0, "wallbox": False, "heatpump": False}
NOTHING = {"pv_kwp": 0.0, "battery_kwh": 0.0, "wallbox": False, "heatpump": False}
FEES = make_items([{"name": "Install Inverter", "type": "InstallationFee"}])


def test_new_pv_without_existing_is_new_system():
    assert classify_offer(PV_BATT, FEES, has_solar=False) == "new_system"


def test_new_pv_with_existing_solar_is_extension():
    assert classify_offer(PV_BATT, FEES, has_solar=True) == "pv_extension"


def test_battery_only_is_retrofit():
    d = dict(NOTHING, battery_kwh=5.0)
    assert classify_offer(d, FEES, has_solar=False) == "battery_retrofit"
    assert classify_offer(dict(d, wallbox=True), FEES, has_solar=False) == "battery_retrofit"


def test_wallbox_only():
    assert classify_offer(dict(NOTHING, wallbox=True), FEES, has_solar=False) == "wallbox_only"


def test_heatpump_only():
    assert classify_offer(dict(NOTHING, heatpump=True), FEES, has_solar=False) == "heatpump_only"


def test_wallbox_beats_heatpump():
    d = dict(NOTHING, wallbox=True, heatpump=True)
    assert classify_offer(d, FEES, has_solar=False) == "wallbox_only"


def test_nothing_is_no_components():
    assert classify_offer(NOTHING, FEES, has_solar=False) == "no_components"
    assert classify_offer(NOTHING, make_items([]), has_solar=False) == "no_components"


def test_stringing_existing_modules_is_extension():
    items = make_items([{"name": "Stringing Existing Modules"}])
    assert classify_offer(PV_BATT, items, has_solar=False) == "pv_extension"


def test_extension_fees_mark_pv_extension():
    for name in ["All-Inclusive Package - Extension", "Travel & Logistics Flat Rate - Extension",
                 "All-Inclusive Package - Extension B", "Travel & Logistics Flat Rate - Extension B"]:
        items = make_items([{"name": name, "type": "InstallationFee"}])
        assert classify_offer(PV_BATT, items, has_solar=False) == "pv_extension", name


def test_extension_fee_without_new_pv_stays_retrofit():
    items = make_items([{"name": "Travel & Logistics Flat Rate - Extension"}])
    d = dict(NOTHING, battery_kwh=5.0)
    assert classify_offer(d, items, has_solar=False) == "battery_retrofit"


def test_battery_extension_item_is_not_a_pv_extension():
    items = make_items([{"name": "Battery 5kWh Extension"}, {"name": "Install Battery Storage - Extension"}])
    assert classify_offer(PV_BATT, items, has_solar=False) == "new_system"


def test_module_replacement_is_pv_extension():
    d = dict(NOTHING, pv_kwp=1.2)
    items = make_items([{"name": "PV Module 400W", "type": "Module", "qty": 3},
                        {"name": "Removal of Old PV Module", "qty": 3}])
    assert classify_offer(d, items, has_solar=False) == "pv_extension"


def test_removal_with_substructure_is_new_system():
    items = make_items([{"name": "Substructure Concrete Roof", "qty": 12},
                        {"name": "Removal of Old PV Module", "qty": 12}])
    assert classify_offer(PV_BATT, items, has_solar=False) == "new_system"


def _opts(rows):
    out = []
    for r in rows:
        rec = {"installer": "A", "project_id": "p1", "pv_kwp": 9.0, "battery_kwh": 0.0, "offer_type": "new_system",
               "existing_battery_kwh": np.nan, "existing_battery_is_planned": False}
        rec["items_signature"] = f"sig{r['option_number']}"
        rec.update(r)
        out.append(rec)
    return pd.DataFrame(out)


def test_primary_is_lowest_full_design():
    out = add_project_columns(_opts([{"option_number": 2}, {"option_number": 3}]))
    assert list(out.is_primary) == [True, False]
    assert list(out.is_full_design) == [True, True]
    assert list(out.n_options) == [2, 2]


def test_primary_prefers_full_design_over_lower_retrofit():
    out = add_project_columns(_opts([{"option_number": 1, "offer_type": "battery_retrofit", "pv_kwp": 0.0},
                                     {"option_number": 2}]))
    assert list(out.is_primary) == [False, True]
    assert list(out.is_full_design) == [False, True]


def test_primary_without_full_design_is_lowest_overall_and_unique():
    out = add_project_columns(_opts([
        {"option_number": 4, "offer_type": "battery_retrofit", "pv_kwp": 0.0, "battery_kwh": 10.0},
        {"option_number": 3, "offer_type": "battery_retrofit", "pv_kwp": 0.0, "battery_kwh": 7.0},
    ]))
    assert out.is_primary.sum() == 1
    assert out.set_index("option_number").is_primary.to_dict() == {4: False, 3: True}


def test_primary_is_per_project_and_installer():
    out = add_project_columns(pd.concat([
        _opts([{"option_number": 5}, {"option_number": 7}]),
        _opts([{"option_number": 1, "project_id": "p2"}]),
        _opts([{"option_number": 9, "installer": "B"}]),
    ], ignore_index=True))
    assert list(out.is_primary) == [True, False, True, True]
    assert list(out.n_options) == [2, 2, 1, 1]


def test_duplicate_option_is_flagged_on_higher_number_only():
    df = _opts([{"option_number": 1}, {"option_number": 2}, {"option_number": 3}])
    df["items_signature"] = ["x", "y", "x"]
    out = add_project_columns(df)
    assert list(out.is_duplicate_option) == [False, False, True]


def test_duplicate_signature_in_other_project_is_not_a_duplicate():
    df = pd.concat([_opts([{"option_number": 1}]), _opts([{"option_number": 2, "project_id": "p2"}])], ignore_index=True)
    df["items_signature"] = "same"
    assert not add_project_columns(df).is_duplicate_option.any()


def test_battery_range_over_all_options():
    out = add_project_columns(_opts([{"option_number": 1, "battery_kwh": 7.0},
                                     {"option_number": 2, "battery_kwh": 10.0},
                                     {"option_number": 3, "battery_kwh": 14.0}]))
    assert (out.battery_kwh_min == 7).all() and (out.battery_kwh_max == 14).all()
    assert (out.pv_kwp_min == 9).all() and (out.pv_kwp_max == 9).all()


def test_zero_battery_counts_in_range():
    out = add_project_columns(_opts([{"option_number": 1, "battery_kwh": 0.0}, {"option_number": 2, "battery_kwh": 8.0}]))
    assert (out.battery_kwh_min == 0).all() and (out.battery_kwh_max == 8).all()


def test_ranges_only_within_same_is_full_design():
    out = add_project_columns(_opts([
        {"option_number": 1, "offer_type": "battery_retrofit", "pv_kwp": 0.0, "battery_kwh": 5.0},
        {"option_number": 2, "battery_kwh": 10.0, "pv_kwp": 8.0},
        {"option_number": 3, "battery_kwh": 14.0, "pv_kwp": 12.0},
    ])).set_index("option_number")
    assert out.loc[1, "battery_kwh_min"] == 5 and out.loc[1, "battery_kwh_max"] == 5
    assert out.loc[2, "battery_kwh_min"] == 10 and out.loc[2, "battery_kwh_max"] == 14
    assert out.loc[3, "pv_kwp_min"] == 8 and out.loc[3, "pv_kwp_max"] == 12
    assert (out.n_options == 3).all()


def test_outliers():
    out = add_project_columns(_opts([
        {"option_number": 1, "pv_kwp": 30.0}, {"option_number": 2, "pv_kwp": 30.1},
        {"option_number": 3, "battery_kwh": 40.0}, {"option_number": 4, "battery_kwh": 40.5},
    ]))
    assert list(out.is_outlier) == [False, True, False, True]


def test_existing_battery_equal_to_sold_kwh_is_planned_on_every_row():
    out = add_project_columns(_opts([
        {"option_number": 1, "battery_kwh": 5.0, "existing_battery_kwh": 7.0},
        {"option_number": 2, "battery_kwh": 7.0, "existing_battery_kwh": 7.0},
    ]))
    assert out.existing_battery_is_planned.all()
    assert out.existing_battery_kwh.isna().all()


def test_existing_battery_not_matching_stays_real():
    out = add_project_columns(_opts([
        {"option_number": 1, "battery_kwh": 10.0, "existing_battery_kwh": 7.0},
    ]))
    assert not out.existing_battery_is_planned.any()
    assert (out.existing_battery_kwh == 7.0).all()


def test_same_kwh_rule_uses_storage_kwh_entered_when_year_rule_blanked_it():
    df = _opts([{"option_number": 1, "battery_kwh": 9.0}])
    df["storage_kwh_entered"] = 9.005
    out = add_project_columns(df)
    assert out.existing_battery_is_planned.all() and out.existing_battery_kwh.isna().all()


def test_year_rule_planned_flag_is_kept():
    df = _opts([{"option_number": 1, "battery_kwh": 0.0, "existing_battery_is_planned": True}])
    out = add_project_columns(df)
    assert out.existing_battery_is_planned.all()


def test_input_not_mutated_and_order_kept():
    df = _opts([{"option_number": 3}, {"option_number": 1}])
    before = df.copy()
    out = add_project_columns(df)
    pd.testing.assert_frame_equal(df, before)
    assert list(out.option_number) == [3, 1]
    assert list(out.is_primary) == [False, True]


def test_tiny_pv_in_full_design_is_implausible_and_outlier():
    out = add_project_columns(_opts([{"option_number": 1, "pv_kwp": 0.45}]))
    assert out.is_full_design.all()
    assert list(out.pv_implausible) == [True]
    assert list(out.is_outlier) == [True]


def test_tiny_pv_in_pv_extension_is_not_implausible():
    out = add_project_columns(_opts([{"option_number": 1, "pv_kwp": 0.45, "offer_type": "pv_extension"}]))
    assert list(out.pv_implausible) == [False]
    assert list(out.is_outlier) == [False]


def test_one_kwp_new_system_is_plausible():
    out = add_project_columns(_opts([{"option_number": 1, "pv_kwp": 1.0}]))
    assert list(out.pv_implausible) == [False]
    assert list(out.is_outlier) == [False]
