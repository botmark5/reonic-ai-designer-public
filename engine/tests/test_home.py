import numpy as np
import pandas as pd

from engine.label_rules.home import clean_status_quo

RAW_COLS = [
    "installer", "project_id", "customer_contact_id", "request_created_at", "offer_created_at", "first_signed_at",
    "country", "energy_demand_wh", "energy_price_per_wh", "energy_price_increase", "energy_price_with_flexible_tariff",
    "base_price_per_month", "base_price_increase", "load_profile", "load_profile_editor_id", "has_ev",
    "ev_annual_drive_distance_km", "has_solar", "solar_size_kwp", "solar_angle", "solar_orientation",
    "solar_built_year", "has_storage", "storage_size_kwh", "storage_built_year", "has_wallbox",
    "wallbox_charge_speed_kw", "heating_existing_type", "heating_existing_cost_per_year",
    "heating_existing_cost_increase_per_year", "heating_existing_electricity_demand_kwh",
    "heating_existing_heating_demand_wh", "house_size_sqm", "house_built_year", "num_inhabitants",
]

BASE = {
    "installer": "installer_a", "customer_contact_id": "c1",
    "offer_created_at": "2025-03-01 10:00:00.000000", "first_signed_at": "2025-03-05 10:00:00.000000",
    "energy_demand_wh": "6000000.0", "energy_price_per_wh": "0.00032", "energy_price_increase": "0.03",
    "load_profile": "H0", "has_ev": "False", "has_solar": "False", "has_storage": "False", "has_wallbox": "False",
}


def sq(*overrides: dict) -> pd.DataFrame:
    rows = []
    for i, ov in enumerate(overrides):
        row = {c: np.nan for c in RAW_COLS}
        row.update(BASE)
        row["project_id"] = f"p{i + 1}"
        row.update(ov)
        rows.append(row)
    return pd.DataFrame(rows, columns=RAW_COLS, dtype=object)


def one(**ov) -> pd.Series:
    out = clean_status_quo(sq(ov))
    assert len(out) == 1
    return out.iloc[0]


def test_default_demand_is_unknown_consumption():
    r = one(energy_demand_wh="4500000.0")
    assert r.annual_kwh_raw == 4500
    assert np.isnan(r.annual_kwh)
    assert r.demand_is_default and not r.demand_is_invalid and not r.consumption_known


def test_invalid_demand():
    r = one(energy_demand_wh="1000.0")
    assert r.demand_is_invalid and not r.demand_is_default
    assert r.annual_kwh_raw == 1
    assert np.isnan(r.annual_kwh) and not r.consumption_known


def test_real_demand_is_kept():
    r = one(energy_demand_wh="6000000.0")
    assert r.annual_kwh == 6000 and r.annual_kwh_raw == 6000
    assert r.consumption_known and not r.demand_is_default and not r.demand_is_invalid


def test_missing_demand_is_not_known():
    r = one(energy_demand_wh=np.nan)
    assert np.isnan(r.annual_kwh) and not r.consumption_known


def test_price_converted_to_eur_per_kwh():
    assert abs(one(energy_price_per_wh="0.00032").price_eur_kwh - 0.32) < 1e-12


def test_price_already_in_eur_per_kwh_is_kept():
    assert one(energy_price_per_wh="0.32282").price_eur_kwh == 0.32282


def test_price_zero_is_nan_and_empty_is_nan():
    assert np.isnan(one(energy_price_per_wh="0.0").price_eur_kwh)
    assert np.isnan(one(energy_price_per_wh=np.nan).price_eur_kwh)


def test_flex_tariff_same_rules():
    assert abs(one(energy_price_with_flexible_tariff="0.00028").flex_tariff_eur_kwh - 0.28) < 1e-12
    assert one(energy_price_with_flexible_tariff="0.3").flex_tariff_eur_kwh == 0.3
    assert np.isnan(one(energy_price_with_flexible_tariff="0").flex_tariff_eur_kwh)
    assert np.isnan(one().flex_tariff_eur_kwh)


def test_price_increase_passthrough():
    assert one(energy_price_increase="0.03").price_increase == 0.03


def test_existing_pv_in_kwp():
    r = one(has_solar="True", solar_size_kwp="9720")
    assert abs(r.existing_pv_kwp - 9.72) < 1e-12
    assert r.has_solar
    assert np.isnan(one(has_solar="False", solar_size_kwp="9720").existing_pv_kwp)
    assert np.isnan(one().existing_pv_kwp)
    assert not one().has_solar


def test_battery_built_in_offer_year_is_planned():
    r = one(has_storage="True", storage_size_kwh="10000", storage_built_year="2025")
    assert r.existing_battery_is_planned
    assert np.isnan(r.existing_battery_kwh)
    assert r.storage_kwh_entered == 10.0


def test_battery_built_after_offer_year_is_planned():
    r = one(has_storage="True", storage_size_kwh="10000", storage_built_year="2026")
    assert r.existing_battery_is_planned and np.isnan(r.existing_battery_kwh)


def test_battery_without_year_is_existing():
    r = one(has_storage="True", storage_size_kwh="5000")
    assert r.existing_battery_kwh == 5.0
    assert not r.existing_battery_is_planned
    assert r.storage_kwh_entered == 5.0


def test_battery_built_before_offer_year_is_existing():
    r = one(has_storage="True", storage_size_kwh="5000", storage_built_year="2020")
    assert r.existing_battery_kwh == 5.0 and not r.existing_battery_is_planned


def test_no_storage_means_no_battery_values():
    r = one(has_storage="False", storage_size_kwh="5000", storage_built_year="2026")
    assert np.isnan(r.existing_battery_kwh) and np.isnan(r.storage_kwh_entered)
    assert not r.existing_battery_is_planned


def test_planned_year_uses_first_signed_at_when_offer_date_empty():
    r = one(has_storage="True", storage_size_kwh="8000", storage_built_year="2025",
            offer_created_at=np.nan, first_signed_at="2025-09-12 00:00:00")
    assert r.existing_battery_is_planned


def test_wallbox_and_ev():
    r = one(has_wallbox="True", has_ev="True", ev_annual_drive_distance_km="15000")
    assert r.has_existing_wallbox and r.has_ev and r.ev_km_year == 15000
    r = one()
    assert not r.has_existing_wallbox and not r.has_ev and np.isnan(r.ev_km_year)


def test_empty_heating_type_is_unknown():
    assert one(heating_existing_type=np.nan).heating_type == "Unknown"
    assert one(heating_existing_type="Gas").heating_type == "Gas"


def test_heating_demands_converted():
    r = one(heating_existing_heating_demand_wh="15000000", heating_existing_electricity_demand_kwh="3500")
    assert r.heating_demand_kwh == 15000 and r.heating_electricity_kwh == 3500
    assert np.isnan(one().heating_demand_kwh)


def test_house_fields():
    r = one(house_size_sqm="140", house_built_year="1990", num_inhabitants="4")
    assert (r.house_sqm, r.house_built_year, r.inhabitants) == (140, 1990, 4)


def test_empty_offer_created_at_falls_back_to_first_signed_at():
    r = one(offer_created_at=np.nan, first_signed_at="2025-09-12 00:00:00")
    assert r.offer_created_at == pd.Timestamp("2025-09-12")
    r = one(offer_created_at="2025-03-01 10:00:00.000000")
    assert r.offer_created_at == pd.Timestamp("2025-03-01 10:00:00")


def test_one_row_per_project_with_identity_columns():
    out = clean_status_quo(sq({}, {"installer": "installer_b"}))
    assert list(out.project_id) == ["p1", "p2"]
    assert list(out.installer) == ["installer_a", "installer_b"]
    for col in ["customer_contact_id", "has_solar", "load_profile", "annual_kwh", "heating_type", "inhabitants",
                "storage_kwh_entered", "existing_battery_is_planned", "flex_tariff_eur_kwh"]:
        assert col in out.columns
    assert out["demand_is_default"].dtype == bool and out["has_ev"].dtype == bool
