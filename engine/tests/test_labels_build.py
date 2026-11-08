"""Integration tests on the real Reonic data (skipped when data/raw is absent)."""
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
RAW_DIR = ROOT / "data" / "raw"
pytestmark = pytest.mark.skipif(not RAW_DIR.exists(), reason="raw Reonic data not present")
# The public copy carries no project ids. Tests that check one known project read "exNN" -> project-id prefix
# from data/example_ids.json (git-ignored, kept next to the raw data) and skip without it.
EXAMPLE_IDS = ROOT / "data" / "example_ids.json"


def pid(label: str) -> str:
    if not EXAMPLE_IDS.exists():
        pytest.skip("data/example_ids.json not present")
    import json

    return json.loads(EXAMPLE_IDS.read_text())[label]


@pytest.fixture(scope="module")
def built():
    from engine.labels import build

    return build(RAW_DIR)


def schema_columns() -> list[str]:
    text = (ROOT / "docs" / "data-notes.md").read_text().split("## expert_designs.parquet schema", 1)[1]
    text = re.split(r"^## ", text, maxsplit=1, flags=re.M)[0]  # stop at the next top-level section
    cols = []
    for line in text.splitlines():
        m = re.match(r"\|\s*([a-z_, ]+?)\s*\|", line)
        if m and m.group(1) not in ("column",):
            cols += [c.strip() for c in m.group(1).split(",")]
    return cols


def test_one_row_per_option(built):
    designs, _ = built
    assert designs.groupby("installer").size().to_dict() == {"installer_b": 357, "installer_a": 1637}
    assert designs.groupby("installer").project_id.nunique().to_dict() == {"installer_b": 336, "installer_a": 1257}
    assert not designs.duplicated(["installer", "project_id", "option_number"]).any()


def test_exactly_one_primary_per_project(built):
    designs, _ = built
    assert (designs.groupby("project_id").is_primary.sum() == 1).all()


def test_every_schema_column_present(built):
    designs, _ = built
    missing = [c for c in schema_columns() if c not in designs.columns]
    assert missing == []
    assert len(schema_columns()) > 50


def test_sizes_non_negative(built):
    designs, _ = built
    assert (designs.pv_kwp >= 0).all() and (designs.battery_kwh >= 0).all()


def test_battery_sizes_in_catalogue(built):
    designs, catalogue = built
    for inst, d in designs[~designs.is_outlier & designs.battery].groupby("installer"):
        sizes = {float(k): n for k, n in catalogue[inst]["battery_kwh"].items()}
        assert set(d.battery_kwh.round(2)) <= set(sizes)
        # independent of the set check: every battery option is counted once, and sizes are home-battery sized
        assert sum(sizes.values()) == len(d)
        assert all(1 < kwh <= 40 for kwh in sizes)


def test_commercial_project_is_outlier(built):
    designs, _ = built
    row = designs[designs.project_id.str.startswith(pid("ex18"))]
    assert row.is_outlier.all()


def test_cross_checks_cover_brief_step3(built):
    from engine.label_rules.items import load_raw
    from engine.labels import cross_checks

    designs, _ = built
    parts, _ = load_raw(RAW_DIR)
    text = cross_checks(designs, parts)
    for header in (
        "== B package kWh vs line kWh",
        "== B substructure band vs pv_kwp",
        "== pv_sources_disagree by source pair",
    ):
        assert header in text
    m = re.search(r"A Substructure qty vs DC Install qty: agree (\d+), differ (\d+)", text)
    assert m, text
    assert int(m.group(2)) < 10
    assert int(m.group(1)) > 1000


def test_placeholder_quantity_design_is_implausible_outlier(built):
    designs, _ = built
    row = designs[designs.project_id.str.startswith(pid("ex36")) & (designs.option_number == 2)]
    assert len(row) == 1
    assert row.pv_implausible.all() and row.is_outlier.all()
    assert (designs.pv_implausible <= designs.is_outlier).all()
    assert not (designs.pv_implausible & ~designs.is_full_design).any()


def test_promo_only_wallbox_options_are_wallbox_true(built):
    designs, _ = built
    for prefix in (pid("ex45"), pid("ex46")):
        row = designs[designs.project_id.str.startswith(prefix) & (designs.option_number == 1)]
        assert len(row) == 1 and row.wallbox.all(), prefix
