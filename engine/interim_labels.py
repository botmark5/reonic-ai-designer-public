"""
engine/interim_labels.py - TEMPORARY expert-design labels until engine/labels.py (Mark) lands.

Produces the label table defined in docs/data-notes.md ("Label table contract"), one row per
project x offer option, plus a per-installer catalogue. As soon as engine/artifacts/expert_designs.parquet
exists, get_labels() returns Mark's table instead and this parser is no longer used.

Parsing rules (same as the data profiling on Saturday, see data_summary in the team chat):
    PV kWp   : Module rows (qty x Wp) -> "xx kWp" in a *Package* name -> max qty of per-panel rows
               (Substructure / DC Install / Roof Mounting, qty > 1) x ASSUMED_MODULE_WP -> "PV Complete Package 8kW"
    battery  : kWh parsed from BatteryStorage names (or the mislabeled inverter_power_kw column, in Wh) x qty,
               extensions summed; else "+ 9kWh" in a package name
    heat pump: heatpump_nominal_power_kw (in W) or "10.5kW" in the name; technology == heatpump also counts
    wallbox  : any Wallbox row; kW from wb_charging_speed_kw (in W)
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import numpy as np
import pandas as pd

ENGINE_DIR = Path(__file__).resolve().parent
RAW_DIR = ENGINE_DIR.parent / "data" / "raw"
ARTIFACTS = ENGINE_DIR / "artifacts"
MARK_LABELS = ARTIFACTS / "expert_designs.parquet"
MARK_CATALOGUE = ARTIFACTS / "catalogue.json"
INTERIM_LABELS = ARTIFACTS / "interim_labels.parquet"
ASSUMED_MODULE_WP = 450      # installer A lists no module rows; the other installer uses 450-480 W

_KWH = r"(\d+(?:[.,]\d+)?)\s*kWh"
_KWP = r"(\d+(?:[.,]\d+)?)\s*kWp"
_KW = r"(\d+(?:[.,]\d+)?)\s*kW(?!h|p)"
_WATT = r"(\d{3})\s*W\b"
_PER_PANEL = r"(Substructure|DC Install|Roof Mounting)"


def _num(pattern: str, text) -> float:
    if not isinstance(text, str):
        return np.nan
    m = re.search(pattern, text, re.I)
    return float(m.group(1).replace(",", ".")) if m else np.nan


def parse_option(g: pd.DataFrame) -> dict:
    """Extract the design of ONE offer option from its line items."""
    ct = g.component_type.fillna("")
    name = g.component_name.fillna("")
    qty = g.quantity.fillna(1.0)

    # ---- PV ----
    modules = g[ct == "Module"]
    pkg = name[name.str.contains("Package", case=False)]
    pkg_kwp = pkg.map(lambda s: _num(_KWP, s)).dropna()
    per_panel = g[name.str.match(_PER_PANEL, case=False) & (qty > 1)]
    pv_complete = name[name.str.contains("PV Complete Package", case=False)].map(lambda s: _num(_KW, s)).dropna()
    if len(modules):
        wp = modules.module_watt_peak.fillna(modules.component_name.map(lambda s: _num(_WATT, s))).fillna(ASSUMED_MODULE_WP)
        pv_kwp, pv_source = float((modules.quantity.fillna(1) * wp).sum() / 1000), "module_rows"
    elif len(pkg_kwp):
        pv_kwp, pv_source = float(pkg_kwp.max()), "package_name"
    elif len(per_panel):
        pv_kwp, pv_source = float(per_panel.quantity.max()) * ASSUMED_MODULE_WP / 1000, f"panel_count_x_{ASSUMED_MODULE_WP}W"
    elif len(pv_complete):
        pv_kwp, pv_source = float(pv_complete.max()), "pv_complete_package"
    else:
        pv_kwp, pv_source = 0.0, "none"

    # ---- battery (capacity sits in the mislabeled inverter_power_kw column, in Wh) ----
    bat = g[ct == "BatteryStorage"]
    kwh = pd.to_numeric(bat.component_name.map(lambda s: _num(_KWH, s)), errors="coerce").fillna(bat.inverter_power_kw / 1000)
    battery_kwh = float((kwh.fillna(0) * bat.quantity.fillna(1)).sum())
    if battery_kwh == 0 and len(pkg):
        pk = pkg.map(lambda s: _num(_KWH, s)).dropna()
        battery_kwh = float(pk.max()) if len(pk) else 0.0

    # ---- inverter (power sits in the mislabeled battery_capacity_kwh column, in W) ----
    inv = g[ct == "Inverter"]
    ikw = pd.to_numeric(inv.component_name.map(lambda s: _num(_KW, s)), errors="coerce").fillna(inv.battery_capacity_kwh / 1000)
    inverter_kw = float((ikw * inv.quantity.fillna(1)).sum()) if len(inv) else np.nan

    # ---- heat pump (nominal power in W) ----
    hp = g[ct == "Heatpump"]
    hkw = (hp.heatpump_nominal_power_kw / 1000).fillna(pd.to_numeric(hp.component_name.map(lambda s: _num(_KW, s)), errors="coerce"))
    heatpump_kw = float(hkw.sum()) if len(hp) else 0.0
    has_hp = heatpump_kw > 0 or bool((g.technology == "heatpump").any())

    # ---- wallbox (speed in W) ----
    wb = g[ct == "Wallbox"]
    wb_kw = float(wb.wb_charging_speed_kw.max() / 1000) if len(wb) and wb.wb_charging_speed_kw.notna().any() else np.nan

    return dict(has_pv=pv_kwp > 0, pv_kwp=round(pv_kwp, 3), pv_source=pv_source,
                has_battery=battery_kwh > 0, battery_kwh=round(battery_kwh, 2),
                has_wallbox=len(wb) > 0, wallbox_kw=wb_kw,
                has_heatpump=has_hp, heatpump_kw=heatpump_kw, inverter_kw=inverter_kw)


def build_interim_labels(raw_dir: Path | str = RAW_DIR) -> pd.DataFrame:
    """Parse every installer folder into the label contract (one row per project x option)."""
    rows = []
    for d in sorted(Path(raw_dir).iterdir()):
        f = d / "project_options_parts.csv"
        if not f.exists():
            continue
        parts = pd.read_csv(f)
        for (pid, oid), g in parts.groupby(["project_id", "option_id"], sort=False):
            rows.append(dict(project_id=pid, installer=d.name, option_id=oid,
                             option_number=int(g.option_number.iloc[0]), **parse_option(g)))
    labels = pd.DataFrame(rows)
    # primary = lowest option number (which option was signed is not recorded)
    labels["is_primary"] = labels.option_number == labels.groupby("project_id").option_number.transform("min")
    dup = labels[labels.is_primary].duplicated("project_id", keep="first")
    labels.loc[labels[labels.is_primary][dup].index, "is_primary"] = False      # ties: keep the first
    return labels


def get_labels(rebuild: bool = False) -> tuple[pd.DataFrame, str]:
    """Mark's expert_designs.parquet if it exists, else the interim parse (cached). Returns (labels, source)."""
    if MARK_LABELS.exists():
        from engine.evaluate import normalize_labels          # accepts engine/labels schema v1.1
        return normalize_labels(pd.read_parquet(MARK_LABELS)), "engine/labels (expert_designs.parquet)"
    if INTERIM_LABELS.exists() and not rebuild:
        return pd.read_parquet(INTERIM_LABELS), "interim_labels (cached)"
    labels = build_interim_labels()
    ARTIFACTS.mkdir(exist_ok=True)
    labels.to_parquet(INTERIM_LABELS, index=False)
    return labels, "interim_labels"


def build_catalogue(labels: pd.DataFrame, min_count: int = 5) -> dict:
    """
    What each installer actually sells: battery sizes, heat pump sizes, wallbox kW.
    Battery sizes come from Mark's catalogue.json when present, otherwise sizes seen >= min_count times.
    """
    mark = json.loads(MARK_CATALOGUE.read_text()) if MARK_CATALOGUE.exists() else {}
    cat = {}
    for inst, g in labels.groupby("installer"):
        counts = g.loc[g.battery_kwh > 0, "battery_kwh"].round(1).value_counts()
        sizes = sorted(float(s) for s in counts[counts >= min_count].index) or sorted(float(s) for s in counts.index)
        m = mark.get(inst)
        if m:
            raw = m.get("battery_kwh", []) if isinstance(m, dict) else m
            if isinstance(raw, dict):                         # engine/labels v1.1: {size: how often sold}
                raw = [k for k, n in raw.items() if n >= 3] or list(raw)
            sizes = sorted(float(x) for x in raw if float(x) > 0) or sizes
        # heat pump sizes as sold (5.5 / 7.5 / 8 / 10.5 / 12.5 kW): catalogue.json counts if present, else the labels
        hp_sizes = m.get("heatpump_kw") if isinstance(m, dict) else None
        if isinstance(hp_sizes, dict):
            hp_sizes = sorted(float(k) for k in hp_sizes if float(k) > 0)
        if not hp_sizes:
            hp = g.loc[g.heatpump_kw > 0, "heatpump_kw"].round(1).value_counts()
            hp_sizes = sorted(float(k) for k in hp.index)
        wb = g.wallbox_kw.dropna() if "wallbox_kw" in g else pd.Series(dtype=float)
        cat[inst] = dict(battery_kwh=sizes, heatpump_kw=hp_sizes,
                         sells_heatpumps=bool(g.has_heatpump.any()),
                         wallbox_kw=float(wb.mode().iloc[0]) if len(wb) else 11.0)
    return cat
