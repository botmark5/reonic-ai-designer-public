"""GET /heldout: ids + curated demo text only, from engine/artifacts (synthetic files, no Reonic data)."""
import json

from fastapi.testclient import TestClient

from engine import api


def _write(tmp_path, name, obj):
    (tmp_path / name).write_text(json.dumps(obj))


def test_heldout_reads_artifacts_ids_and_text_only(tmp_path, monkeypatch):
    _write(tmp_path, "test_ids.json", {"seed": 42, "test_project_ids": ["a", "b", "c"]})
    _write(tmp_path, "demo_reality.json", {"cases": [
        {"role": "ev_wallbox", "why": "EV owner", "project_id": "b", "home": {"annual_kwh": 5000}, "expert": {}}]})
    _write(tmp_path, "demo_projects.json", {"projects": [
        {"role": "ev_wallbox", "why": "dup", "project_id": "b", "home": {}},
        {"role": "battery_retrofit", "why": "retrofit", "project_id": "c", "expert_primary": {"pv_kwp": 0}}]})
    monkeypatch.setattr(api, "ARTIFACTS", tmp_path)
    monkeypatch.delenv("ENGINE_API_KEY", raising=False)
    api.heldout_lists.cache_clear()
    try:
        r = TestClient(api.app).get("/heldout")
    finally:
        api.heldout_lists.cache_clear()
    assert r.status_code == 200
    body = r.json()
    assert body["test_project_ids"] == ["a", "b", "c"]
    assert body["demo_projects"] == [
        {"role": "two_houses_ev_wallbox", "why": "EV owner", "project_id": "b"},
        {"role": "battery_retrofit", "why": "retrofit", "project_id": "c"}]
    assert set(body) == {"test_project_ids", "demo_projects"}


def test_heldout_needs_the_key(tmp_path, monkeypatch):
    monkeypatch.setattr(api, "ARTIFACTS", tmp_path)
    monkeypatch.setenv("ENGINE_API_KEY", "k")
    assert TestClient(api.app).get("/heldout").status_code == 401
