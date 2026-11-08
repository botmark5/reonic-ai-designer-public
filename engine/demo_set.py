"""
Demo set: 5 real HELD-OUT projects that tell the 5-minute demo story.

    python -m engine.demo_set             -> engine/artifacts/demo_projects.json (derived from Reonic data: never committed)
    python -m engine.demo_set --reality   -> engine/artifacts/demo_reality.json: 3 cases for the /reality "two houses"
                                             view where the engine's held-out design is close to the expert's

Projects come only from the locked test set (engine/artifacts/test_ids.json, the same file engine/train.py uses;
created with Cala's locked_split if missing), so the model has never trained on them. Each role is picked by a fixed
rule (no randomness), so every machine with the same labels + test_ids.json gets the same five projects.

Per project: project_id (hash), installer id, home inputs in api.md names, the expert primary design, the expert
variant range and every expert option. No names, contacts, addresses or customer ids; offer date as month only.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

from engine.evaluate import ARTIFACTS, build_eval_table, inputs_from_labels, locked_split

LABELS = ARTIFACTS / "expert_designs.parquet"
REALITY_OUT = ARTIFACTS / "demo_reality.json"
PV_CLOSE_KWP, BATTERY_CLOSE_KWH = 1.0, 2.5   # "close": PV within 1 kWp, battery within about one catalogue step
TEST_IDS = ARTIFACTS / "test_ids.json"
OUT = ARTIFACTS / "demo_projects.json"

INPUT_COLS = ["annual_kwh", "demand_is_default", "consumption_known", "price_eur_kwh", "load_profile", "has_ev",
              "ev_km_year", "heating", "heating_demand_kwh", "existing_pv", "existing_battery", "existing_wallbox"]
PRIMARY_COLS = ["pv_kwp", "pv_panels", "pv_source", "battery_kwh", "wallbox", "n_wallboxes", "wallbox_kw",
                "heatpump", "heatpump_kw", "inverter_kw", "brand", "roof_type", "offer_type"]
OPTION_COLS = ["option_number", "is_primary", "pv_kwp", "battery_kwh", "wallbox", "heatpump_kw", "is_full_design"]


def _closest_to_median(df: pd.DataFrame, cols: list[str]) -> pd.Series:
    """Row nearest the median on the given columns (each scaled by its spread); ties broken by project_id."""
    z = sum(((df[c] - df[c].median()) / (df[c].std() or 1.0)).abs() for c in cols)
    return df.assign(_z=z).sort_values(["_z", "project_id"]).iloc[0]


def pick_roles(test: pd.DataFrame, labels: pd.DataFrame) -> list[tuple[str, str, str]]:
    """[(role, project_id, why)] — one project per demo role, by fixed rules on the held-out table."""
    real_demand = test.consumption_known.fillna(False).astype(bool) & ~test.demand_is_default.fillna(False).astype(bool)
    new = test[(test.offer_type == "new_system") & real_demand]
    hp_option = labels.groupby("project_id").heatpump_kw.max().fillna(0) > 0
    picks = []

    typical = new[new.has_pv & new.has_battery & ~new.has_wallbox & ~new.has_heatpump & (new.has_ev != True)]
    r = _closest_to_median(typical, ["annual_kwh", "pv_kwp", "battery_kwh"])
    picks.append(("typical_pv_battery", r.project_id,
                  f"Typical new PV + battery home: closest to the median of {len(typical)} held-out PV+battery homes"))

    ev = new[(new.has_ev == True) & new.has_wallbox]
    r = _closest_to_median(ev, ["annual_kwh", "pv_kwp"])
    picks.append(("ev_wallbox", r.project_id, f"EV owner, expert added a wallbox ({len(ev)} such held-out homes)"))

    gas = test[test.project_id.map(hp_option).fillna(False).astype(bool) & test.heating.isin(["Gas", "Oil"])]
    r = gas.sort_values(["heating", "project_id"]).iloc[0]  # "Gas" sorts before "Oil"
    hp_kw = labels.loc[labels.project_id == r.project_id, "heatpump_kw"].max()
    picks.append(("heatpump_option", r.project_id,
                  f"{r.heating} heating, {r.heating_demand_kwh:,.0f} kWh/yr heat demand; the expert offered a "
                  f"{hp_kw:g} kW heat pump ({len(gas)} such held-out home(s))"))

    retro = test[(test.offer_type == "battery_retrofit") & test.consumption_known.fillna(False).astype(bool)]
    r = _closest_to_median(retro, ["battery_kwh"])
    picks.append(("battery_retrofit", r.project_id,
                  f"Existing PV, expert sold a battery only ({len(retro)} held-out retrofits with known consumption)"))

    # spread over FULL-design options only: a wallbox-only side option is not a PV disagreement
    full = labels[labels.is_full_design.astype(bool) & ~labels.is_outlier.astype(bool)]
    spread = full.groupby("project_id").agg(n_full=("pv_kwp", "size"), pv_lo=("pv_kwp", "min"), pv_hi=("pv_kwp", "max"),
                                            bat_lo=("battery_kwh", "min"), bat_hi=("battery_kwh", "max"))
    multi = new.join(spread, on="project_id", how="inner")
    multi = multi[multi.n_full >= 2].assign(pv_spread=lambda d: d.pv_hi - d.pv_lo, bat_spread=lambda d: d.bat_hi - d.bat_lo)
    r = multi.sort_values(["pv_spread", "bat_spread", "project_id"], ascending=[False, False, True]).iloc[0]
    picks.append(("experts_disagree", r.project_id,
                  f"{r.n_full:g} full-design variants from the expert: PV {r.pv_lo:g}–{r.pv_hi:g} kWp, "
                  f"battery {r.bat_lo:g}–{r.bat_hi:g} kWh (widest PV range of {len(multi)} multi-variant homes)"))
    return picks


def _close(e_pv: float, e_bat: float, e_wb: bool, o_pv: float, o_bat: float, o_wb: bool) -> bool:
    """Same components (PV yes/no, battery yes/no, wallbox yes/no) and sizes within the 'close' tolerances."""
    e_pv, e_bat, o_pv, o_bat = (0.0 if x is None or pd.isna(x) else float(x) for x in (e_pv, e_bat, o_pv, o_bat))
    return ((e_pv > 0) == (o_pv > 0) and (e_bat > 0) == (o_bat > 0) and bool(e_wb) == bool(o_wb)
            and abs(e_pv - o_pv) <= PV_CLOSE_KWP and abs(e_bat - o_bat) <= BATTERY_CLOSE_KWH)


def pick_reality(test: pd.DataFrame, labels: pd.DataFrame, pred: pd.DataFrame, live=None) -> list[dict]:
    """
    3 held-out cases for the /reality "two houses" view, where the engine's design is close to the expert's.
    pred = held-out predictions (model trained on the train split only, NOT told about existing solar) indexed like
    test. live(project_id) -> the design /project/{id} returns (shipped model), or None to skip that check.
    Roles: typical new PV + battery, EV with a wallbox, then the first close case of: battery retrofit, heat-pump
    option, large home.
    Within a role: candidates ordered by closeness to the role's median, first one close in both checks wins.
    """
    t = test.join(pred.add_prefix("pred_"))
    real_demand = t.consumption_known.fillna(False).astype(bool) & ~t.demand_is_default.fillna(False).astype(bool)
    new = t[(t.offer_type == "new_system") & real_demand]
    retro = t[(t.offer_type == "battery_retrofit") & t.consumption_known.fillna(False).astype(bool)]
    hp_option = labels.groupby("project_id").heatpump_kw.max().fillna(0) > 0
    gas = t[t.project_id.map(hp_option).fillna(False).astype(bool) & t.heating.isin(["Gas", "Oil"])]
    roles = [
        ("typical_pv_battery", new[new.has_pv & new.has_battery & ~new.has_wallbox & ~new.has_heatpump & (new.has_ev != True)
                                   & new.pv_kwp.between(6, 14)], ["annual_kwh", "pv_kwp", "battery_kwh"],
         "Typical new home: solar + battery, no wallbox"),
        ("ev_wallbox", new[(new.has_ev == True) & new.has_wallbox & new.has_pv], ["annual_kwh", "pv_kwp"],
         "EV owner: solar + wallbox"),
        ("battery_retrofit", retro, ["battery_kwh"], "Solar already on the roof: the expert sold a battery only"),
        ("heatpump_option", gas, ["annual_kwh"], "Gas or oil heating: the expert offered a heat pump"),
        ("large_home", new[new.has_pv & new.has_battery & ~new.has_heatpump & (new.annual_kwh >= 7000)],
         ["annual_kwh", "pv_kwp", "battery_kwh"], "Large home (7,000+ kWh a year): a bigger solar + battery system"),
    ]
    picks = []
    for role, cands, cols, story in roles:
        if len(picks) == 3:     # retrofit, else heat pump, else large home: the first that has a close case
            break
        z = sum(((cands[c] - cands[c].median()) / (cands[c].std() or 1.0)).abs() for c in cols) if len(cands) > 1 else 0
        cands = cands.assign(_z=z).sort_values(["_z", "project_id"])
        for _, r in cands.iterrows():
            if not _close(r.pv_kwp, r.battery_kwh, r.has_wallbox, r.pred_pv_kwp, r.pred_battery_kwh, r.pred_has_wallbox):
                continue
            ours_live = live(r.project_id) if live else None
            if ours_live is not None and not _close(r.pv_kwp, r.battery_kwh, r.has_wallbox, ours_live["pv_kwp"],
                                                    ours_live["battery_kwh"], ours_live["wallbox"]):
                continue
            picks.append(dict(role=role, project_id=r.project_id, story=story, n_candidates=len(cands),
                              ours_held_out=dict(pv_kwp=_clean(r.pred_pv_kwp), battery_kwh=_clean(r.pred_battery_kwh),
                                                 wallbox=bool(r.pred_has_wallbox), heatpump_kw=_clean(r.pred_heatpump_kw),
                                                 offer_type=r.pred_offer_type),
                              ours_live=ours_live))
            break
    return picks


def build_reality_set(labels: pd.DataFrame, test_ids_path: Path = TEST_IDS, live=None) -> dict:
    from engine.model import DesignModel

    table = build_eval_table(labels, inputs_from_labels(labels))
    train, test = locked_split(table, test_ids_path)
    test = test.reset_index(drop=True)
    pred = DesignModel().fit(train)._run(test)[["has_pv", "pv_kwp", "has_battery", "battery_kwh", "has_wallbox",
                                                "heatpump_kw", "offer_type"]].set_index(test.index)
    by_project, rows = labels.set_index("project_id"), test.set_index("project_id")
    cases = []
    for p in pick_reality(test, labels, pred, live):
        row, opts = rows.loc[p["project_id"]], by_project.loc[[p["project_id"]]].sort_values("option_number")
        primary = opts[opts.is_primary.astype(bool)].iloc[0]
        expert = dict(pv_kwp=_clean(primary.pv_kwp), battery_kwh=_clean(primary.battery_kwh),
                      wallbox=bool(primary.wallbox), heatpump_kw=_clean(primary.heatpump_kw), offer_type=primary.offer_type)
        o = p["ours_held_out"]
        # no sizes in the text: /reality shows the live design next to it, and the held-out sizes can differ slightly
        why = (f"{p['story']}. A model that never saw this home also came within {PV_CLOSE_KWP:g} kWp of the expert's "
               f"solar and about one battery size")
        cases.append({**{k: p[k] for k in ("role", "project_id")}, "why": why, "installer": row.installer,
                      "offer_month": pd.Timestamp(row.offer_date).strftime("%Y-%m") if pd.notna(row.offer_date) else None,
                      "home": {c: _clean(row[c]) for c in INPUT_COLS},
                      "expert": expert, "ours_held_out": o, "ours_live": p["ours_live"],
                      "expert_options": [{c: _clean(x[c]) for c in OPTION_COLS if c in x} for _, x in opts.iterrows()]})
    return {"source": {"labels": LABELS.name, "test_ids": Path(test_ids_path).name,
                       "rule": (f"held-out projects; same components and PV within {PV_CLOSE_KWP:g} kWp, battery within "
                                f"{BATTERY_CLOSE_KWH:g} kWh of the expert, for the held-out model (train split only, not "
                                "told about existing solar) AND for what /project/{id} returns; closest to the role "
                                "median wins; engine/demo_set.py pick_reality"),
                       "ours_live_note": "ours_live = the shipped model behind /project, trained on all projects "
                                         "including this one; ours_held_out never saw it"},
            "cases": cases}


def live_design(project_id: str) -> dict | None:
    """The design GET /project/{id} returns (calls the API function in-process, no server or key needed)."""
    from engine.api import project

    # answered=False explicitly: called in-process, the FastAPI Query(False) default object would be truthy
    ours = (project(project_id, answered=False) or {}).get("ours")
    if not ours:
        return None
    d = ours["design"]
    return dict(pv_kwp=d["pv"]["kwp"] or 0.0, battery_kwh=d["battery"]["kwh"] or 0.0,
                wallbox=bool(d["wallbox"]["include"]), heatpump_kw=d["heatpump"]["kw"] or 0.0,
                offer_type=ours.get("facts_for_explanation", {}).get("offer_type"))


def _clean(value):
    if isinstance(value, (np.bool_, bool)):
        return bool(value)
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating, float)):
        return None if np.isnan(value) else round(float(value), 3)
    return None if value is pd.NA or value is pd.NaT else value


def build_demo_set(labels: pd.DataFrame, test_ids_path: Path = TEST_IDS) -> dict:
    table = build_eval_table(labels, inputs_from_labels(labels))
    _, test = locked_split(table, test_ids_path)
    test = test.set_index("project_id", drop=False)
    by_project = labels.set_index("project_id")
    projects = []
    for role, pid, why in pick_roles(test.reset_index(drop=True), labels):
        row, opts = test.loc[pid], by_project.loc[[pid]].sort_values("option_number")
        primary = opts[opts.is_primary.astype(bool)].iloc[0]
        projects.append({
            "role": role,
            "why": why,
            "project_id": pid,
            "installer": row.installer,
            "offer_month": pd.Timestamp(row.offer_date).strftime("%Y-%m") if pd.notna(row.offer_date) else None,
            "home": {c: _clean(row[c]) for c in INPUT_COLS},
            "expert_primary": {c: _clean(primary[c]) for c in PRIMARY_COLS if c in primary},
            "expert_range": {c: _clean(row[c]) for c in ["pv_min", "pv_max", "battery_min", "battery_max", "n_options"]},
            "expert_options": [{c: _clean(o[c]) for c in OPTION_COLS if c in o} for _, o in opts.iterrows()],
        })
    return {"source": {"labels": LABELS.name, "test_ids": Path(test_ids_path).name,
                       "rule": "held-out projects only; fixed selection rules in engine/demo_set.py"},
            "projects": projects}


def main() -> None:
    import sys

    if "--reality" in sys.argv:
        out = build_reality_set(pd.read_parquet(LABELS), live=live_design)
        REALITY_OUT.write_text(json.dumps(out, indent=2, ensure_ascii=False))
        for c in out["cases"]:
            print(f"{c['role']:<20} {c['project_id']}  live {c['ours_live']}  — {c['why']}")
        print(f"-> {REALITY_OUT}")
        return
    demo = build_demo_set(pd.read_parquet(LABELS))
    OUT.write_text(json.dumps(demo, indent=2, ensure_ascii=False))
    for p in demo["projects"]:
        e = p["expert_primary"]
        print(f"{p['role']:<20} {p['project_id']}  PV {e.get('pv_kwp')} kWp · battery {e.get('battery_kwh')} kWh · "
              f"wallbox {e.get('wallbox')} · HP {e.get('heatpump_kw')} kW  — {p['why']}")
    print(f"-> {OUT}")


if __name__ == "__main__":
    main()
