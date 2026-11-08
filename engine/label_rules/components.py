"""Battery, wallbox, heat pump, inverter, brand and backup rules (R2-R5, R8 in docs/labels-rules.md).

Each function is pure over the line items of ONE offer option (a frame from `items.make_items` / `load_raw`).
Raw numeric columns are shifted in the data: `inverter_power_kw` holds battery Wh on BatteryStorage rows,
`battery_capacity_kwh` holds inverter W on Inverter rows; `wb_charging_speed_kw` and
`heatpump_nominal_power_kw` are in W.
"""
import math
import re

import pandas as pd

_NUM = r"(\d+(?:[.,]\d+)?)"
KWH_RE = re.compile(_NUM + r"\s*kWh", re.I)
KW_RE = re.compile(_NUM + r"\s*kW(?![a-z])", re.I)
W_RE = re.compile(_NUM + r"\s*W(?![a-z])", re.I)
PACKAGE_KWH_RE = re.compile(r"Complete Package.*?\+\s*" + _NUM + r"\s*kWh", re.I)

BATTERY_EXCLUDED_RE = re.compile(r"AC Coupling Module|Extended Warranty|Tower|Power Module", re.I)
BATTERY_EXTENSION_RE = re.compile(r"^Battery\s+\d[\d.,]*\s*kWh\s+Extension", re.I)
WALLBOX_FEE_RE = re.compile(r"^(?:Install Wallbox|Wallbox Installation)(?: [A-Z])?$|^All-Inclusive Package - Wallbox", re.I)
# Wallbox sold only as an "Other"-typed product or promo line (no Wallbox row): evidence when nothing else says wallbox.
WALLBOX_PROMO_RE = re.compile(r"Free .*Wallbox|Wallbox Promo|^EV Charger", re.I)
WALLBOX_PROMO_EXCLUDED_RE = re.compile(r"Prep|Expenses|Cable|Meter|Power Boost|Subsidy Deadline", re.I)
BACKUP_RE = re.compile(
    r"Smart Guard|Backup Box|Emergency Power|Backup Solution|Home Backup Interface|Transfer Switch", re.I
)
PACKAGE_BRAND_RE = re.compile(r"^Complete Package \d+ (\S+)", re.I)
MANAGER_RE = re.compile(r"Energy Manager|Optimizer|Smart Meter|Energy Meter", re.I)

KNOWN_BRANDS = ("Huawei", "Flowmax", "SAJ", "SolarEdge", "Enphase", "Voltara", "Gridwell", "Kestrel", "Azzurro")
LAST_LEVEL_BRAND = "Smartfox"
NEVER_BRANDS = frozenset(
    ["Insurer", "Mennekes", "BirdBlocker", "Novotegra", "Braas", "F-Tronic", "Vaillant", "Aira", "Sunpro", "Lynus", "AIKO", "Trina", "SL Rack"]
)
_BRAND_BY_LOWER = {b.lower(): b for b in KNOWN_BRANDS + (LAST_LEVEL_BRAND,)}


def _to_float(text: str) -> float:
    return float(text.replace(",", "."))


def _positive(value) -> bool:
    return not pd.isna(value) and value > 0


def _rows(items: pd.DataFrame):
    return items.to_dict("records")


def _name_number(regex: re.Pattern, name: str) -> float | None:
    match = regex.search(name)
    return _to_float(match.group(1)) if match else None


# ---------------------------------------------------------------- R2 battery

def extract_battery(items: pd.DataFrame) -> dict:
    total, used_column = 0.0, False
    for row in _rows(items):
        name, ctype = row["component_name"], row["component_type"]
        if ctype == "BatteryStorage":
            if BATTERY_EXCLUDED_RE.search(name):
                continue
        elif not (ctype == "AccessoryToBatteryStorage" and BATTERY_EXTENSION_RE.search(name)):
            continue
        qty = row["quantity"]
        if _positive(row["inverter_power_kw"]):
            total += qty * row["inverter_power_kw"] / 1000.0
            used_column = True
        else:
            kwh = _name_number(KWH_RE, name)
            if kwh is not None:
                total += qty * kwh
    if total > 0:
        return {"battery": True, "battery_kwh": total, "battery_source": "numeric_column" if used_column else "name"}
    for name in items["component_name"]:
        kwh = _name_number(PACKAGE_KWH_RE, name)
        if kwh:
            return {"battery": True, "battery_kwh": kwh, "battery_source": "package_name"}
    return {"battery": False, "battery_kwh": 0.0, "battery_source": "none"}


# ---------------------------------------------------------------- R3 wallbox

def extract_wallbox(items: pd.DataFrame) -> dict:
    wallboxes = items[items["component_type"] == "Wallbox"]
    installed = any(WALLBOX_FEE_RE.search(name) for name in items["component_name"])
    # Promo / "Other"-typed product lines count only as evidence, never as an extra wallbox next to a Wallbox row.
    promo_names = [
        name
        for name, ctype in zip(items["component_name"], items["component_type"])
        if ctype != "Wallbox" and WALLBOX_PROMO_RE.search(name) and not WALLBOX_PROMO_EXCLUDED_RE.search(name)
    ]
    if wallboxes.empty and not installed and not promo_names:
        return {"wallbox": False, "wallbox_kw": math.nan, "n_wallboxes": 0.0}
    speeds = wallboxes["wb_charging_speed_kw"]
    kw = speeds[speeds > 0].max() / 1000.0 if (speeds > 0).any() else math.nan
    if wallboxes.empty:
        for name in promo_names:
            named = _name_number(KW_RE, name)
            if named is not None:
                kw = named
                break
    n = float(wallboxes["quantity"].sum()) if not wallboxes.empty else 1.0
    return {"wallbox": True, "wallbox_kw": float(kw), "n_wallboxes": n}


# ---------------------------------------------------------------- R4 heat pump

def extract_heatpump(items: pd.DataFrame) -> dict:
    pumps = items[items["component_type"] == "Heatpump"]
    if pumps.empty:
        return {"heatpump": False, "heatpump_kw": math.nan}
    total, found = 0.0, False
    for row in _rows(pumps):
        kw = _name_number(KW_RE, row["component_name"])
        if kw is None and _positive(row["heatpump_nominal_power_kw"]):
            kw = row["heatpump_nominal_power_kw"] / 1000.0
        if kw is not None:
            total += row["quantity"] * kw
            found = True
    return {"heatpump": True, "heatpump_kw": total if found else math.nan}


# ---------------------------------------------------------------- R5 inverter

def _is_inverter_row(row: dict) -> bool:
    return row["component_type"] == "Inverter" or (row["component_type"] == "Other" and "inverter" in row["component_name"].lower())


def _inverter_row_kw(row: dict) -> float | None:
    name = row["component_name"]
    kw = _name_number(KW_RE, name)
    if kw is None:
        watts = _name_number(W_RE, name)
        kw = watts / 1000.0 if watts is not None else None
    if kw is None and row["component_type"] == "Inverter" and _positive(row["battery_capacity_kwh"]):
        kw = row["battery_capacity_kwh"] / 1000.0
    return kw


def extract_inverter(items: pd.DataFrame) -> dict:
    total, found = 0.0, False
    for row in _rows(items):
        if not _is_inverter_row(row):
            continue
        kw = _inverter_row_kw(row)
        if kw is not None:
            total += row["quantity"] * kw
            found = True
    return {"inverter_kw": total if found else math.nan}


# ---------------------------------------------------------------- R8 brand and backup

def _row_brand(row: dict, allow_last_level: bool) -> str | None:
    """Brand of one row: its brand column, else the first word of its name when that is a known brand."""
    brand = row["component_brand"]
    first_word = row["component_name"].split(" ", 1)[0] if row["component_name"] else ""
    candidates = [brand, _BRAND_BY_LOWER.get(first_word.lower(), "")]
    for candidate in candidates:
        if not candidate or candidate in NEVER_BRANDS:
            continue
        if candidate == LAST_LEVEL_BRAND and not allow_last_level:
            continue
        return candidate
    return None


def extract_brand(items: pd.DataFrame) -> str:
    rows = _rows(items)
    levels = [
        [r for r in rows if r["component_type"] == "BatteryStorage"],
        [r for r in rows if _is_inverter_row(r)],
        [r for r in rows if r["component_type"] == "Wallbox"],
    ]
    for level in levels:
        for row in level:
            brand = _row_brand(row, allow_last_level=False)
            if brand:
                return brand
    for row in rows:
        match = PACKAGE_BRAND_RE.match(row["component_name"])
        if match:
            brand = _row_brand({**row, "component_name": match.group(1)}, allow_last_level=False)
            if brand:
                return brand
    for row in rows:
        if MANAGER_RE.search(row["component_name"]):
            brand = _row_brand(row, allow_last_level=True)
            if brand:
                return brand
    return "Unknown"


def has_backup(items: pd.DataFrame) -> bool:
    return any(BACKUP_RE.search(name) for name in items["component_name"])
