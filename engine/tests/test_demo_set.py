"""Demo set (engine/demo_set.py) on the real labels; skipped when the derived parquet is absent."""
import json

import pandas as pd
import pytest

from engine.demo_set import LABELS, build_demo_set

pytestmark = pytest.mark.skipif(not LABELS.exists(), reason="expert_designs.parquet not built")

ROLES = ["typical_pv_battery", "ev_wallbox", "heatpump_option", "battery_retrofit", "experts_disagree"]


@pytest.fixture(scope="module")
def demo(tmp_path_factory):
    # own test_ids file so the test never writes the shared one; same seed and rule as engine/train.py
    return build_demo_set(pd.read_parquet(LABELS), tmp_path_factory.mktemp("ids") / "test_ids.json"), tmp_path_factory


def test_five_distinct_roles_and_projects(demo):
    d, _ = demo
    assert [p["role"] for p in d["projects"]] == ROLES
    assert len({p["project_id"] for p in d["projects"]}) == 5


def test_every_project_is_held_out(demo):
    d, factory = demo
    ids = set(json.loads(next(factory.getbasetemp().glob("ids*/test_ids.json")).read_text())["test_project_ids"])
    assert {p["project_id"] for p in d["projects"]} <= ids


def test_roles_match_the_story(demo):
    p = {x["role"]: x for x in demo[0]["projects"]}
    assert p["typical_pv_battery"]["expert_primary"]["pv_kwp"] > 0 and p["typical_pv_battery"]["expert_primary"]["battery_kwh"] > 0
    assert p["ev_wallbox"]["home"]["has_ev"] and p["ev_wallbox"]["expert_primary"]["wallbox"]
    assert p["heatpump_option"]["home"]["heating"] in ("Gas", "Oil")
    assert any((o.get("heatpump_kw") or 0) > 0 for o in p["heatpump_option"]["expert_options"])
    assert p["battery_retrofit"]["expert_primary"]["offer_type"] == "battery_retrofit"
    full = [o for o in p["experts_disagree"]["expert_options"] if o["is_full_design"]]
    assert len(full) >= 2 and len({o["pv_kwp"] for o in full}) >= 2


def test_no_personal_fields(demo):
    text = json.dumps(demo[0]).lower()
    for field in ("customer_contact_id", "address", "street", "email", "phone", "first_name", "last_name"):
        assert field not in text
