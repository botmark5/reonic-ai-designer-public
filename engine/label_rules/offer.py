"""Offer type per option and the project-level columns (primary row, variant ranges, duplicates, outliers).

Rules: docs/labels-rules.md, "Step 3 - edge cases" and the "Primary label" paragraph.
"""
import re

import pandas as pd

PV_EXTENSION_NAME = re.compile(
    r"Stringing Existing Modules"
    r"|(?:All-Inclusive Package|Travel & Logistics Flat Rate) - Extension",
    re.IGNORECASE,
)
PV_REMOVAL_NAME = re.compile(r"Removal of Old PV Module", re.IGNORECASE)
SUBSTRUCTURE_NAME = re.compile(r"Substructure", re.IGNORECASE)

OUTLIER_PV_KWP = 30
OUTLIER_BATTERY_KWH = 40
MIN_PLAUSIBLE_FULL_PV_KWP = 1.0  # a full design below this is placeholder quantities (qty 1 left in the planner)
SAME_KWH_TOLERANCE = 0.01
PROJECT_KEY = ["installer", "project_id"]


def classify_offer(design: dict, items: pd.DataFrame, has_solar: bool) -> str:
    """offer_type of one option. design: pv_kwp, battery_kwh, wallbox, heatpump; items: its line items."""
    if design["pv_kwp"] > 0:
        names = items["component_name"].fillna("").astype(str) if "component_name" in items else pd.Series([], dtype=str)
        has_substructure = names.str.contains(SUBSTRUCTURE_NAME).any()
        extends_existing = (
            bool(has_solar)
            or names.str.contains(PV_EXTENSION_NAME).any()
            or (names.str.contains(PV_REMOVAL_NAME).any() and not has_substructure)
        )
        return "pv_extension" if extends_existing else "new_system"
    if design["battery_kwh"] > 0:
        return "battery_retrofit"
    if design["wallbox"]:
        return "wallbox_only"
    if design["heatpump"]:
        return "heatpump_only"
    return "no_components"


def add_project_columns(df: pd.DataFrame) -> pd.DataFrame:
    """Add is_full_design, is_primary, n_options, is_duplicate_option, variant ranges, pv_implausible and is_outlier.

    Also settles the planned-battery flag: when any option of the project sells the battery size the
    planner entered as "existing" (within 0.01 kWh), that battery is the planned one.
    """
    out = df.reset_index(drop=True)
    out["is_full_design"] = (out["offer_type"] == "new_system").astype(bool)
    grp = out.groupby(PROJECT_KEY, sort=False)
    out["n_options"] = grp["option_number"].transform("size").astype(int)

    # Primary: lowest option_number among full designs, else lowest overall. Exactly one per project.
    rank = out.assign(_not_full=~out["is_full_design"]).sort_values(
        PROJECT_KEY + ["_not_full", "option_number"], kind="stable"
    )
    primary_idx = rank.groupby(PROJECT_KEY, sort=False).head(1).index
    out["is_primary"] = out.index.isin(primary_idx)

    # Duplicate: same items_signature as a lower-numbered option of the same project.
    by_number = out.sort_values(PROJECT_KEY + ["option_number"], kind="stable")
    dup = by_number.duplicated(subset=PROJECT_KEY + ["items_signature"], keep="first")
    out["is_duplicate_option"] = pd.Series(dup, index=by_number.index).reindex(out.index).astype(bool)

    # Variant ranges within the same is_full_design value.
    rng_key = PROJECT_KEY + ["is_full_design"]
    for col in ("pv_kwp", "battery_kwh"):
        g = out.groupby(rng_key, sort=False)[col]
        out[f"{col}_min"] = g.transform("min")
        out[f"{col}_max"] = g.transform("max")

    out["pv_implausible"] = (out["is_full_design"] & (out["pv_kwp"] > 0) & (out["pv_kwp"] < MIN_PLAUSIBLE_FULL_PV_KWP)).astype(bool)
    out["is_outlier"] = (
        (out["pv_kwp"] > OUTLIER_PV_KWP) | (out["battery_kwh"] > OUTLIER_BATTERY_KWH) | out["pv_implausible"]
    ).astype(bool)

    # Same-kWh rule for the "existing" battery.
    entered = out["storage_kwh_entered"] if "storage_kwh_entered" in out else out["existing_battery_kwh"]
    entered = pd.to_numeric(entered, errors="coerce")
    sold_same = (
        (entered > 0)
        & ((out["battery_kwh"] - entered).abs() <= SAME_KWH_TOLERANCE)
    ).groupby([out["installer"], out["project_id"]], sort=False).transform("any")
    planned = out["existing_battery_is_planned"].astype(bool) | sold_same.astype(bool)
    out["existing_battery_is_planned"] = planned
    out["existing_battery_kwh"] = pd.to_numeric(out["existing_battery_kwh"], errors="coerce").where(~planned)
    out.index = df.index
    return out
