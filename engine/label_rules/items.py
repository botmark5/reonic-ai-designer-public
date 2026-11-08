"""Loading raw Reonic line items and building test fixtures in the same shape.

Raw numeric columns keep their CSV names. They are shifted in the data:
`inverter_power_kw` holds battery Wh on BatteryStorage rows and `battery_capacity_kwh`
holds inverter W on Inverter rows (see docs/labels-rules.md).
"""
from pathlib import Path

import pandas as pd

RAW_NUM_COLS = [
    "quantity",
    "module_watt_peak",
    "inverter_power_kw",
    "battery_capacity_kwh",
    "wb_charging_speed_kw",
    "heatpump_nominal_power_kw",
]
RAW_STR_COLS = ["technology", "line_item_function", "component_type", "component_name", "component_brand", "quantity_units"]

_FIXTURE_KEYS = {"name": "component_name", "type": "component_type", "tech": "technology", "brand": "component_brand", "qty": "quantity"}
_FIXTURE_DEFAULTS = {"component_type": "Other", "technology": "solar", "component_brand": "", "quantity": 1.0}


def _normalise(parts: pd.DataFrame) -> pd.DataFrame:
    parts = parts.copy()
    for col in RAW_STR_COLS:
        parts[col] = parts[col].fillna("").astype(str) if col in parts else ""
    for col in RAW_NUM_COLS:
        parts[col] = pd.to_numeric(parts[col], errors="coerce").astype(float) if col in parts else float("nan")
    return parts


def make_items(rows: list[dict]) -> pd.DataFrame:
    """Line items of one option, for tests. Keys: name, type, tech, brand, qty, or any raw column name."""
    records = []
    for row in rows:
        rec = dict(_FIXTURE_DEFAULTS)
        for key, value in row.items():
            rec[_FIXTURE_KEYS.get(key, key)] = value
        records.append(rec)
    return _normalise(pd.DataFrame.from_records(records))


def load_raw(raw_dir: Path) -> tuple[pd.DataFrame, pd.DataFrame]:
    """(parts, status_quo) for every installer folder under raw_dir, each with an `installer` column."""
    parts, status_quo = [], []
    for folder in sorted(p for p in Path(raw_dir).iterdir() if p.is_dir()):
        p = pd.read_csv(folder / "project_options_parts.csv", dtype=str)
        s = pd.read_csv(folder / "projects_status_quo.csv", dtype=str)
        p.insert(0, "installer", folder.name)
        s.insert(0, "installer", folder.name)
        parts.append(p)
        status_quo.append(s)
    parts_df = _normalise(pd.concat(parts, ignore_index=True))
    parts_df["option_number"] = parts_df["option_number"].astype(int)
    return parts_df, pd.concat(status_quo, ignore_index=True)
