"""
engine/features.py - turn a home (api.md field names) into model features.

Used by BOTH training and prediction, so a feature is always computed the same way.
Input columns (as produced by evaluate.load_inputs and by the API): installer, annual_kwh, price_eur_kwh,
load_profile, has_ev, ev_km_year, heating, heating_demand_kwh, existing_pv, existing_battery,
existing_wallbox, offer_date. Missing columns get safe defaults, so a half-filled form still works.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from engine.physics import FOSSIL_HEATING, ev_kwh, heatpump_extra_kwh

DATE_ORIGIN = pd.Timestamp("2024-01-01")
DEFAULT_DEMAND_KWH = 4500          # suspiciously frequent value: probably the tool's default, not measured
DAYTIME_PROFILES = {"HomeOfficeOnePerson": 1, "SeniorOnePerson": 1, "FullTimeOnePerson": -1, "PartTimeOnePerson": 0}

NUMERIC_FEATURES = [
    "total_demand_kwh",     # household + EV + new heat pump electricity (physics layer)
    "annual_kwh",           # household demand as entered
    "demand_is_default",    # 1 if exactly 4,500 kWh
    "price_eur_kwh",
    "has_ev", "ev_km",
    "heating_is_heatpump", "heating_is_fossil", "heating_demand_kwh",
    "existing_pv", "existing_battery", "existing_wallbox",
    "load_profile_is_h0", "daytime_presence",
    "offer_month",          # months since Jan 2024: captures trends (batteries got bigger)
]
EXTRA_TEXT = {
    "total_demand_kwh": "total yearly electricity demand", "annual_kwh": "household electricity demand",
    "demand_is_default": "the demand being the default 4,500 kWh", "price_eur_kwh": "the electricity price",
    "has_ev": "the electric car", "ev_km": "the yearly EV distance", "heating_is_heatpump": "the existing heat pump",
    "heating_is_fossil": "the gas/oil heating", "heating_demand_kwh": "the heating demand",
    "existing_pv": "PV already on the roof", "existing_battery": "the existing battery",
    "existing_wallbox": "the existing wallbox", "load_profile_is_h0": "the standard household profile",
    "daytime_presence": "who is at home during the day", "offer_month": "the recent offer trend",
    "pv_kwp_planned": "the planned PV size",
}


def _col(df, name, default):
    return df[name] if name in df.columns else pd.Series(default, index=df.index)


def tristate(s: pd.Series) -> pd.Series:
    """True/1 -> 1.0, False/0 -> 0.0, None/NaN -> NaN (unknown)."""
    def one(v):
        if v is None or (isinstance(v, float) and np.isnan(v)):
            return np.nan
        return 1.0 if bool(v) else 0.0
    return s.map(one).astype(float)


def clean_inputs(df: pd.DataFrame) -> pd.DataFrame:
    """Dirty values -> unknown (NaN): demand <= 0, price <= 0 or > 1 EUR/kWh."""
    df = df.copy()
    if "annual_kwh" in df:
        df.loc[df.annual_kwh < 1500, "annual_kwh"] = np.nan       # invalid entries (21 projects at 0-1 kWh)
    if "price_eur_kwh" in df:
        bad = (df.price_eur_kwh <= 0) | (df.price_eur_kwh > 1)
        df.loc[bad, "price_eur_kwh"] = np.nan
    return df


def offer_month(dates, cap: float | None = None) -> pd.Series:
    """Months since Jan 2024. Missing date (a new project) -> the cap, i.e. 'recent, typical'."""
    m = ((pd.to_datetime(dates, errors="coerce") - DATE_ORIGIN).dt.days / 30.44).round()
    if cap is not None:
        m = m.fillna(cap).clip(upper=cap)
    return m


def build_features(df: pd.DataFrame, heatpump_kw, installers: list[str], offer_month_cap: float | None = None) -> pd.DataFrame:
    """
    df: homes (one row each); heatpump_kw: NEW heat pump per row (adds electricity demand);
    installers: known installers -> one-hot columns (an unseen installer gets all zeros).
    """
    df = clean_inputs(df)
    X = pd.DataFrame(index=df.index)
    inst = _col(df, "installer", "")
    for i in installers:
        X[f"inst_{i}"] = (inst == i).astype(int)
    X["annual_kwh"] = _col(df, "annual_kwh", np.nan).astype(float)
    flag = _col(df, "demand_is_default", np.nan)
    X["demand_is_default"] = np.where(flag.notna(), flag.fillna(False).astype(bool), X.annual_kwh == DEFAULT_DEMAND_KWH).astype(int)
    X["price_eur_kwh"] = _col(df, "price_eur_kwh", np.nan).astype(float)
    X["has_ev"] = _col(df, "has_ev", False).fillna(False).astype(bool).astype(int)
    km = _col(df, "ev_km_year", np.nan).astype(float)
    X["ev_km"] = km.fillna(0)
    heating = _col(df, "heating", None)
    X["heating_is_heatpump"] = (heating == "Heatpump").astype(int)
    X["heating_is_fossil"] = heating.isin(FOSSIL_HEATING).astype(int)
    X["heating_demand_kwh"] = _col(df, "heating_demand_kwh", np.nan).astype(float)
    # existing PV: 1 = yes, 0 = no, NaN = unknown (the data almost never records it; the planner can answer it)
    X["existing_pv"] = tristate(_col(df, "existing_pv", np.nan))
    for c in ("existing_battery", "existing_wallbox"):
        X[c] = _col(df, c, False).fillna(False).astype(bool).astype(int)
    profile = _col(df, "load_profile", "H0").fillna("H0")
    X["load_profile_is_h0"] = (profile == "H0").astype(int)
    X["daytime_presence"] = profile.map(DAYTIME_PROFILES).fillna(0)
    X["offer_month"] = offer_month(_col(df, "offer_date", pd.NaT), offer_month_cap)

    # physics layer: what the system must cover
    hp = pd.Series(heatpump_kw, index=df.index).fillna(0).astype(float)
    ev_extra = [ev_kwh(bool(e), None if pd.isna(k) else k)[0] for e, k in zip(X.has_ev, km)]
    hp_extra = [heatpump_extra_kwh(h if not pd.isna(h) else k * 2450) if k > 0 else 0.0
                for k, h in zip(hp, X.heating_demand_kwh)]
    X["total_demand_kwh"] = X.annual_kwh + np.array(ev_extra) + np.array(hp_extra)
    return X[[f"inst_{i}" for i in installers] + NUMERIC_FEATURES]


def feature_text(name: str) -> str:
    if name.startswith("inst_"):
        return "the installer's catalogue"
    return EXTRA_TEXT.get(name, name)
