"""Spot-check report: raw offer line items next to the extracted expert design.

    .venv/bin/python -m engine.spotcheck

Samples 20 projects (seed 42, stratified by installer) and writes engine/artifacts/spotcheck.md for a human
to judge whether the labels are right. The file contains project ids and raw items: it is git-ignored, never commit it.
"""
import math

import numpy as np
import pandas as pd

from engine.labels import ARTIFACTS, RAW_DIR
from engine.label_rules.items import load_raw

OUT_PATH = ARTIFACTS / "spotcheck.md"

# The raw numeric columns are shifted (see engine/label_rules/items.py): what the number means depends on the row type.
VALUE_BY_TYPE = {
    "Module": ("module_watt_peak", "module", "W"),
    "BatteryStorage": ("inverter_power_kw", "battery", "Wh"),
    "Inverter": ("battery_capacity_kwh", "inverter", "W"),
    "Wallbox": ("wb_charging_speed_kw", "wallbox", "W"),
    "Heatpump": ("heatpump_nominal_power_kw", "heat pump", "W"),
}
FLAGS = [
    "is_duplicate_option", "is_outlier", "pv_sources_disagree", "roof_mixed", "has_backup",
]


def sample_projects(designs: pd.DataFrame, n: int = 20, seed: int = 42) -> list[str]:
    """n project ids, stratified by installer: the largest installer takes the remainder, every other one
    gets ceil(its share of n), at least 1."""
    projects = designs.drop_duplicates("project_id")[["installer", "project_id"]]
    sizes = projects.groupby("installer").size().sort_values(ascending=False)
    quota = {inst: max(1, math.ceil(n * k / len(projects))) for inst, k in sizes.items()}
    quota[sizes.index[0]] = max(1, n - sum(v for i, v in quota.items() if i != sizes.index[0]))
    rng = np.random.default_rng(seed)
    chosen = []
    for inst in sorted(quota):
        ids = sorted(projects.project_id[projects.installer == inst])
        take = min(quota[inst], len(ids))
        chosen += list(rng.choice(ids, size=take, replace=False))
    return sorted(chosen)


def _num(x) -> str:
    return "n/a" if pd.isna(x) else f"{float(x):g}"


def _true(x) -> bool:
    """NaN-safe truth: a missing value is not True."""
    return bool(pd.notna(x) and x)


def _yes(x) -> str:
    return "yes" if _true(x) else "no"


def _value(item: pd.Series) -> str:
    spec = VALUE_BY_TYPE.get(item.component_type)
    if spec is None or pd.isna(item.get(spec[0])):
        return ""
    return f"{spec[1]} {float(item[spec[0]]):g} {spec[2]}"


def _cell(text) -> str:
    return str(text).replace("|", "/").replace("\n", " ")


def _design_line(d: pd.Series) -> str:
    assumed = f" @ {_num(d.pv_wp_assumed)} W assumed" if pd.notna(d.get("pv_wp_assumed")) else ""
    parts = [
        f"{d.offer_type}",
        f"PV {_num(d.pv_kwp)} kWp ({_num(d.pv_panels)} panels{assumed}, {d.pv_source})",
        f"battery {_num(d.battery_kwh)} kWh ({d.battery_source})",
        f"wallbox {_yes(d.wallbox)}" + (f" {_num(d.wallbox_kw)} kW" if _true(d.wallbox) else ""),
        f"heat pump {_num(d.heatpump_kw)} kW" if _true(d.heatpump) else "heat pump no",
        f"inverter {_num(d.inverter_kw)} kW",
        f"roof {d.roof_type}",
        f"scaffolding {_yes(d.has_scaffolding)}",
        f"brand {d.brand}",
    ]
    flags = [f for f in FLAGS if f in d and _true(d[f])]
    if flags:
        parts.append("flags: " + ", ".join(flags))
    return "; ".join(parts)


def _project_header(d: pd.Series) -> str:
    marker = " (invalid)" if _true(d.get("demand_is_invalid")) else " (default)" if _true(d.get("demand_is_default")) else ""
    kwh = f"{_num(d.annual_kwh_raw)} kWh/yr{marker}"
    return (
        f"installer {d.installer}; annual consumption {kwh}; EV {_yes(d.has_ev)}; "
        f"existing PV {_num(d.existing_pv_kwp)} kWp; existing battery {_num(d.existing_battery_kwh)} kWh"
    )


def render_spotcheck(designs: pd.DataFrame, parts: pd.DataFrame, n: int = 20, seed: int = 42) -> str:
    ids = sample_projects(designs, n=n, seed=seed)
    out = [
        "# Label spot-check",
        "",
        f"{len(ids)} projects sampled (seed {seed}, stratified by installer). For each option: the extracted design, "
        "then the raw line items. Judge: are the extracted sizes what the offer actually contains?",
        "Raw numeric columns are shifted in the data; the value column shows each number with its real meaning.",
        "",
    ]
    for k, pid in enumerate(ids, 1):
        proj = designs[designs.project_id == pid].sort_values(["is_primary", "option_number"], ascending=[False, True])
        out += [f"## {k}. Project {pid}", "", _project_header(proj.iloc[0]), ""]
        for _, d in proj.iterrows():
            mark = " (primary)" if _true(d.is_primary) else ""
            out += [f"### Option {int(d.option_number)}{mark}", "", f"Extracted: {_design_line(d)}", ""]
            items = parts[(parts.project_id == pid) & (parts.option_number == d.option_number)]
            if "installer" in items:
                items = items[items.installer == d.installer]
            out += ["| name | type | brand | qty | value |", "| --- | --- | --- | --- | --- |"]
            for _, it in items.iterrows():
                out.append(
                    f"| {_cell(it.component_name)} | {_cell(it.component_type)} | {_cell(it.component_brand)} "
                    f"| {_num(it.quantity)} | {_value(it)} |"
                )
            out.append("")
    return "\n".join(out)


def main() -> None:
    designs = pd.read_parquet(ARTIFACTS / "expert_designs.parquet")
    parts, _ = load_raw(RAW_DIR)
    md = render_spotcheck(designs, parts)
    OUT_PATH.write_text(md)
    print(f"{OUT_PATH} ({len(sample_projects(designs))} projects)")


if __name__ == "__main__":
    main()
