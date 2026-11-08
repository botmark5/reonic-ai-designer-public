"""Cleaning of the raw status-quo table (one row per project = the home before the offer).

Output columns follow the "Home features" table in docs/data-notes.md. Raw units are shifted in the data:
`solar_size_kwp` and `storage_size_kwh` are really Wp and Wh, `wallbox_charge_speed_kw` is W,
`energy_price_per_wh` is EUR/Wh (a few rows were typed in EUR/kWh already).
"""
import pandas as pd

DEFAULT_DEMAND_WH = 4_500_000
INVALID_DEMAND_KWH = 1_500
# A raw price above this was typed in EUR/kWh (real EUR/Wh values are ~0.0003-0.0005).
PRICE_ALREADY_KWH = 0.01

IDENTITY_COLS = ["installer", "project_id", "customer_contact_id"]


def _num(sq: pd.DataFrame, col: str) -> pd.Series:
    if col not in sq:
        return pd.Series(float("nan"), index=sq.index, dtype=float)
    return pd.to_numeric(sq[col], errors="coerce").astype(float)


def _flag(sq: pd.DataFrame, col: str) -> pd.Series:
    if col not in sq:
        return pd.Series(False, index=sq.index, dtype=bool)
    return (sq[col].astype(str).str.strip().str.lower() == "true").astype(bool)


def _price_eur_kwh(raw: pd.Series) -> pd.Series:
    """EUR/Wh -> EUR/kWh; values already in EUR/kWh are kept; 0 (and negatives) -> NaN."""
    raw = raw.where(raw > 0)
    return raw.where(raw > PRICE_ALREADY_KWH, raw * 1000)


def clean_status_quo(sq: pd.DataFrame) -> pd.DataFrame:
    """One row per project with the cleaned home features (see module docstring)."""
    sq = sq.reset_index(drop=True)
    out = pd.DataFrame(index=sq.index)
    for col in IDENTITY_COLS:
        out[col] = sq[col].astype(str) if col in sq else ""

    offer = pd.to_datetime(sq["offer_created_at"], errors="coerce") if "offer_created_at" in sq else pd.Series(pd.NaT, index=sq.index)
    signed = pd.to_datetime(sq["first_signed_at"], errors="coerce") if "first_signed_at" in sq else pd.Series(pd.NaT, index=sq.index)
    out["offer_created_at"] = offer.fillna(signed)

    demand_wh = _num(sq, "energy_demand_wh")
    out["annual_kwh_raw"] = demand_wh / 1000
    out["demand_is_default"] = (demand_wh == DEFAULT_DEMAND_WH).astype(bool)
    out["demand_is_invalid"] = (out["annual_kwh_raw"] < INVALID_DEMAND_KWH).astype(bool)
    out["consumption_known"] = (
        ~out["demand_is_default"] & ~out["demand_is_invalid"] & out["annual_kwh_raw"].notna()
    ).astype(bool)
    out["annual_kwh"] = out["annual_kwh_raw"].where(out["consumption_known"])

    out["price_eur_kwh"] = _price_eur_kwh(_num(sq, "energy_price_per_wh"))
    out["price_increase"] = _num(sq, "energy_price_increase")
    out["flex_tariff_eur_kwh"] = _price_eur_kwh(_num(sq, "energy_price_with_flexible_tariff"))
    out["load_profile"] = sq["load_profile"] if "load_profile" in sq else float("nan")
    out["has_ev"] = _flag(sq, "has_ev")
    out["ev_km_year"] = _num(sq, "ev_annual_drive_distance_km")

    has_solar = _flag(sq, "has_solar")
    out["has_solar"] = has_solar
    out["existing_pv_kwp"] = (_num(sq, "solar_size_kwp") / 1000).where(has_solar)

    has_storage = _flag(sq, "has_storage")
    entered = (_num(sq, "storage_size_kwh") / 1000).where(has_storage)
    built = _num(sq, "storage_built_year")
    planned = (has_storage & built.notna() & (built >= out["offer_created_at"].dt.year)).astype(bool)
    out["storage_kwh_entered"] = entered
    out["existing_battery_is_planned"] = planned
    out["existing_battery_kwh"] = entered.where(~planned)

    out["has_existing_wallbox"] = _flag(sq, "has_wallbox")
    heating = sq["heating_existing_type"] if "heating_existing_type" in sq else pd.Series(float("nan"), index=sq.index)
    out["heating_type"] = heating.astype("object").where(heating.notna() & (heating.astype(str).str.strip() != ""), "Unknown")
    out["heating_demand_kwh"] = _num(sq, "heating_existing_heating_demand_wh") / 1000
    out["heating_electricity_kwh"] = _num(sq, "heating_existing_electricity_demand_kwh")
    out["house_sqm"] = _num(sq, "house_size_sqm")
    out["house_built_year"] = _num(sq, "house_built_year")
    out["inhabitants"] = _num(sq, "num_inhabitants")
    return out
