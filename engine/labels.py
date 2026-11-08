"""Build the expert-design table and the installer catalogue from the raw Reonic data.

    .venv/bin/python -m engine.labels

Writes engine/artifacts/expert_designs.parquet (one row per project × option, schema in
docs/data-notes.md) and engine/artifacts/catalogue.json (sizes each installer actually sells),
then prints cross-checks. Rules: docs/labels-rules.md.
"""
import json
import re
from pathlib import Path

import pandas as pd

from engine.label_rules.components import (
    PACKAGE_KWH_RE,
    extract_battery,
    extract_brand,
    extract_heatpump,
    extract_inverter,
    extract_wallbox,
    has_backup,
)
from engine.label_rules.home import clean_status_quo
from engine.label_rules.items import load_raw
from engine.label_rules.offer import add_project_columns, classify_offer
from engine.label_rules.pv import (
    DC_INSTALL,
    INSTALLER_A,
    INSTALLER_B,
    PACKAGE_B,
    PANEL_WP_ASSUMED,
    SIZE_BAND,
    PANEL_SUBSTRUCTURE,
    TOLERANCE_KWP,
    extract_pv,
    extract_roof_type,
    has_scaffolding,
)

ROOT = Path(__file__).resolve().parents[1]
RAW_DIR = ROOT / "data" / "raw"
ARTIFACTS = ROOT / "engine" / "artifacts"

# "Substructure Cross-Lay up to 6kWp": the open-ended lowest band (pv.py only knows "A-B kWp").
_UP_TO_BAND = re.compile(r"^(?:SL Rack )?Substructure\b.*?up to\s*(\d+(?:\.\d+)?)\s*kWp", re.I)

FRONT_COLUMNS = [
    "installer", "project_id", "customer_contact_id", "option_id", "option_number", "is_primary", "n_options",
    "is_duplicate_option", "offer_type", "is_full_design",
    "pv_kwp", "pv_panels", "pv_source", "pv_wp_assumed", "pv_sources_disagree",
    "battery", "battery_kwh", "battery_source", "wallbox", "wallbox_kw", "n_wallboxes", "heatpump", "heatpump_kw",
    "inverter_kw", "roof_type", "roof_mixed", "has_scaffolding", "has_backup", "brand", "n_line_items",
    "pv_kwp_min", "pv_kwp_max", "battery_kwh_min", "battery_kwh_max", "pv_implausible", "is_outlier",
]


def extract_option(items: pd.DataFrame, installer: str) -> dict:
    """All per-option labels for the line items of one offer option."""
    out = {}
    out.update(extract_pv(items, installer))
    out.update(extract_roof_type(items))
    out["has_scaffolding"] = has_scaffolding(items)
    out.update(extract_battery(items))
    out.update(extract_wallbox(items))
    out.update(extract_heatpump(items))
    out.update(extract_inverter(items))
    out["brand"] = extract_brand(items)
    out["has_backup"] = has_backup(items)
    out["n_line_items"] = len(items)
    out["items_signature"] = "||".join(sorted(f"{n}|{q:g}" for n, q in zip(items.component_name, items.quantity)))
    return out


def _counts(values: pd.Series) -> dict:
    vc = values.dropna().astype(float).round(2).value_counts().sort_index()
    return {f"{k:g}": int(v) for k, v in vc.items()}


def make_catalogue(designs: pd.DataFrame) -> dict:
    """Sizes each installer sells (non-outlier options), with how often each was offered."""
    catalogue = {}
    for installer, d in designs[~designs.is_outlier].groupby("installer"):
        catalogue[installer] = {
            "pv": {
                "wp_per_panel": PANEL_WP_ASSUMED,
                "panels": _counts(d.pv_panels[d.pv_kwp > 0]),
                "package_kwp": _counts(d.pv_kwp[d.pv_source == "package_name"]),
            },
            "battery_kwh": _counts(d.battery_kwh[d.battery]),
            "wallbox_kw": _counts(d.wallbox_kw),
            "heatpump_kw": _counts(d.heatpump_kw),
            "inverter_kw": _counts(d.inverter_kw),
            "brands": {k: int(v) for k, v in d.brand.value_counts().items()},
        }
    return catalogue


def build(raw_dir: Path = RAW_DIR) -> tuple[pd.DataFrame, dict]:
    parts, status_quo = load_raw(raw_dir)
    homes = clean_status_quo(status_quo)
    has_solar = dict(zip(zip(homes.installer, homes.project_id), homes.has_solar.astype(bool)))

    rows = []
    keys = ["installer", "project_id", "option_number", "option_id"]
    for (installer, project_id, option_number, option_id), items in parts.groupby(keys, sort=True):
        rec = {"installer": installer, "project_id": project_id, "option_id": option_id, "option_number": int(option_number)}
        rec.update(extract_option(items, installer))
        rec["offer_type"] = classify_offer(rec, items, has_solar[(installer, project_id)])
        rows.append(rec)

    designs = pd.DataFrame(rows).merge(homes, on=["installer", "project_id"], how="left", validate="many_to_one")
    designs = add_project_columns(designs)
    designs = designs[FRONT_COLUMNS + [c for c in designs.columns if c not in FRONT_COLUMNS]]
    return designs.reset_index(drop=True), make_catalogue(designs)


def _per_option_facts(designs: pd.DataFrame, parts: pd.DataFrame) -> pd.DataFrame:
    """One row per option with the raw-line quantities the cross-checks compare (indexed like designs by installer+option_id)."""
    names, qty = parts["component_name"], parts["quantity"].fillna(1.0)
    f = parts[["installer", "option_id"]].copy()
    f["sub"] = qty.where(names.str.match(PANEL_SUBSTRUCTURE), 0.0)
    f["dc"] = qty.where(names.str.match(DC_INSTALL), 0.0)
    f["pkg_kwh"] = names.map(lambda n: float(m.group(1).replace(",", ".")) if (m := PACKAGE_KWH_RE.search(n)) else float("nan"))
    f["pkg_kwp"] = names.map(lambda n: float(m.group(1)) if (m := PACKAGE_B.match(n)) else float("nan"))
    is_module = (parts["component_type"] == "Module") & (parts["module_watt_peak"] > 0)
    f["module_kwp"] = (qty * parts["module_watt_peak"]).where(is_module) / 1000
    f["band"] = names.map(_band_of)
    facts = f.groupby(["installer", "option_id"]).agg(
        sub=("sub", "sum"), dc=("dc", "sum"), pkg_kwh=("pkg_kwh", "first"), pkg_kwp=("pkg_kwp", "first"),
        module_kwp=("module_kwp", lambda s: s.sum() if s.notna().any() else float("nan")),
        band=("band", lambda s: next((b for b in s if b is not None), None)),
    ).reset_index()
    return designs.merge(facts, on=["installer", "option_id"], how="left", validate="one_to_one")


def _band_of(name: str) -> tuple[float, float] | None:
    if m := SIZE_BAND.match(name):
        return float(m.group(1)), float(m.group(2))
    if m := _UP_TO_BAND.match(name):
        return 0.0, float(m.group(1))
    return None


def _agree_line(label: str, agree: pd.Series) -> str:
    return f"{label}: agree {int(agree.sum())}, differ {int((~agree).sum())} (of {len(agree)} options with both)"


def _source_pair_checks(d: pd.DataFrame) -> list[str]:
    """Which pair of PV sources disagrees, and how that lines up with the pv_sources_disagree flag."""
    a2 = d[(d.installer == INSTALLER_A) & (d["sub"] > 0) & (d.dc > 0)]
    sub_eq_dc = (a2["sub"] - a2.dc).abs() < 0.5
    c23 = d[(d.installer == INSTALLER_B) & d.pkg_kwp.notna() & d.module_kwp.notna()]
    pkg_eq_mod = (c23.pkg_kwp - c23.module_kwp).abs() <= TOLERANCE_KWP
    lines = [
        _agree_line("A Substructure qty vs DC Install qty", sub_eq_dc),
        "  pv_sources_disagree among those: "
        f"{int(a2.pv_sources_disagree[sub_eq_dc].sum())} of the agreeing, {int(a2.pv_sources_disagree[~sub_eq_dc].sum())} of the differing",
        _agree_line("B package kWp vs module-line kWp", pkg_eq_mod),
        "  pv_sources_disagree among those: "
        f"{int(c23.pv_sources_disagree[pkg_eq_mod].sum())} of the agreeing, {int(c23.pv_sources_disagree[~pkg_eq_mod].sum())} of the differing",
    ]
    flagged = d[d.pv_sources_disagree]
    rest = flagged[~flagged.index.isin(a2.index[~sub_eq_dc]) & ~flagged.index.isin(c23.index[~pkg_eq_mod])]
    lines.append(f"pv_sources_disagree total {len(flagged)}; not explained by either pair above: {len(rest)} "
                 "(e.g. package vs per-panel count, roof mounting vs substructure)")
    if len(rest):
        lines.append(rest.groupby(["installer", "pv_source"]).size().to_string())
    return lines


def cross_checks(designs: pd.DataFrame, parts: pd.DataFrame) -> str:
    def table(col: str, frame: pd.DataFrame = designs) -> str:
        return pd.crosstab(frame[col], frame.installer, margins=True).to_string()

    d = _per_option_facts(designs, parts)
    c23 = d[d.installer == INSTALLER_B]

    # package "+ Y kWh" in the name vs BatteryStorage rows (battery_kwh from lines unless the package is the only source)
    both = c23[c23.pkg_kwh.notna() & c23.battery_source.isin(["numeric_column", "name"])]
    kwh_agree = (both.pkg_kwh - both.battery_kwh).abs() <= TOLERANCE_KWP
    kwh_lines = [_agree_line("package kWh vs battery line kWh", kwh_agree)]
    if (~kwh_agree).any():
        near = (both.pkg_kwh - both.battery_kwh).abs() <= 0.3
        kwh_lines.append(f"  of the differing, within 0.3 kWh (package name rounds the Kestrel module-level sizes, e.g. 10 vs 9.84): {int((near & ~kwh_agree).sum())}")
        pairs = both[~kwh_agree].groupby(["pkg_kwh", "battery_kwh"]).size().sort_values(ascending=False).head(10)
        kwh_lines += ["top differing pairs (package kWh, line kWh): options", pairs.to_string()]

    # "Substructure 6-8.8kWp" / "up to 6kWp" band vs the pv_kwp we chose
    banded = c23[c23.band.notna() & (c23.pv_kwp > 0)]
    in_band = banded.apply(lambda r: r.band[0] - TOLERANCE_KWP <= r.pv_kwp <= r.band[1] + TOLERANCE_KWP, axis=1)
    band_lines = [f"in band {int(in_band.sum())}, out of band {int((~in_band).sum())} (of {len(banded)} options with a band line and pv_kwp > 0)"]
    band_lines.append("by pv_source (in band / options):\n" + banded.assign(in_band=in_band).groupby("pv_source").in_band.agg(["sum", "size"]).to_string())
    if (~in_band).any():
        band_lines.append("out of band, by band and pv_source (pv_kwp range):\n" + banded[~in_band].assign(band=lambda x: x.band.map(lambda b: f"{b[0]:g}-{b[1]:g}"))
                          .groupby(["band", "pv_source"]).pv_kwp.agg(["size", "min", "max"]).to_string())

    primary = designs[designs.is_primary]
    full = designs[designs.is_full_design & ~designs.is_outlier]
    lines = [
        "== pv_source (all options)", table("pv_source"),
        "== battery_source", table("battery_source"),
        "== offer_type", table("offer_type"),
        "== offer_type of primary rows", table("offer_type", primary),
        "== pv_sources_disagree", table("pv_sources_disagree"),
        "== pv_sources_disagree by source pair", *_source_pair_checks(d),
        "== B package kWh vs line kWh", *kwh_lines,
        "== B substructure band vs pv_kwp", *band_lines,
        "== roof_type (options with PV)", table("roof_type", designs[designs.pv_kwp > 0]),
        "== outliers", designs[designs.is_outlier][["installer", "project_id", "option_number", "pv_kwp", "battery_kwh"]].to_string(),
        "== primary full designs: pv_kwp / battery_kwh quantiles",
        full[full.is_primary].groupby("installer")[["pv_kwp", "battery_kwh"]].quantile([0.05, 0.5, 0.95]).to_string(),
        "== consumption_known share (projects)", designs.drop_duplicates("project_id").groupby("installer").consumption_known.mean().round(3).to_string(),
    ]
    return "\n".join(lines)


def main() -> None:
    designs, catalogue = build()
    parts, _ = load_raw(RAW_DIR)
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    designs.to_parquet(ARTIFACTS / "expert_designs.parquet", index=False)
    (ARTIFACTS / "catalogue.json").write_text(json.dumps(catalogue, indent=2))
    # plain ASCII: a cp1252 Windows console cannot print "x" / "->" as Unicode symbols (UnicodeEncodeError)
    print(f"wrote {len(designs)} rows x {designs.shape[1]} columns -> {ARTIFACTS / 'expert_designs.parquet'}")
    print(cross_checks(designs, parts))


if __name__ == "__main__":
    main()
