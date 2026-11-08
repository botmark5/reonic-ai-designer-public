"""
engine/error_analysis.py - where and why the engine deviates from the experts (locked test set).

    python -m engine.error_analysis     -> prints, writes engine/artifacts/error_analysis.md

Segments: installer, true offer type, consumption band, demand default, PV label source; offer-type confusion;
P10-P90 / battery-range coverage; the 10 largest PV misses with their inputs.
"""
from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

from engine.evaluate import ARTIFACTS, OFFER_GROUP, build_eval_table, inputs_from_labels, locked_split, planner_answer
from engine.interim_labels import get_labels
from engine.model import DesignModel

warnings.filterwarnings("ignore")


def run(answered: bool):
    labels, _ = get_labels()
    table = build_eval_table(labels, inputs_from_labels(labels))
    train, test = locked_split(table, ARTIFACTS / "test_ids.json")
    model = DesignModel().fit(train)
    feats = test.assign(existing_pv=planner_answer(test)) if answered else test
    out = model._run(feats)
    t = test.copy()
    t["pred_has_pv"], t["pred_pv"], t["pred_bat"] = out.has_pv.to_numpy(), out.pv_kwp.to_numpy(), out.battery_kwh.to_numpy()
    t["pred_has_bat"], t["pred_type"] = out.has_battery.to_numpy(), out.offer_type.to_numpy()
    lo = out.pv_lo if "pv_lo" in out else np.minimum(out.pv_p10, out.pv_p90)
    hi = out.pv_hi if "pv_hi" in out else np.maximum(out.pv_p10, out.pv_p90)
    t["pv_lo"], t["pv_hi"] = np.minimum(lo, out.pv_kwp).to_numpy(), np.maximum(hi, out.pv_kwp).to_numpy()
    t["pv_err"] = (t.pred_pv - t.pv_kwp).abs()
    t["bat_err"] = (t.pred_bat - t.battery_kwh).abs()
    t["band"] = pd.cut(t.annual_kwh, [0, 3000, 4500, 6000, 9000, 1e9], labels=["<3k", "3-4.5k", "4.5-6k", "6-9k", ">9k"])
    t["true_group"] = t.offer_type.map(OFFER_GROUP)
    pv_src = labels[labels.is_primary].set_index("project_id").pv_source
    t["pv_source"] = t.project_id.map(pv_src).fillna("?")
    return t


def seg_table(t: pd.DataFrame, by: str) -> pd.DataFrame:
    both = t.has_pv & t.pred_has_pv
    bat = t.has_battery & t.pred_has_bat
    g = t.groupby(by, observed=True)
    return pd.DataFrame({
        "n": g.size(),
        "PV yes/no %": g.apply(lambda d: (d.has_pv == d.pred_has_pv).mean() * 100),
        "PV MAE (both)": g.apply(lambda d: d.pv_err[d.has_pv & d.pred_has_pv].mean()),
        "PV bias (both)": g.apply(lambda d: (d.pred_pv - d.pv_kwp)[d.has_pv & d.pred_has_pv].mean()),
        "battery yes/no %": g.apply(lambda d: (d.has_battery == d.pred_has_bat).mean() * 100),
        "battery MAE (both)": g.apply(lambda d: d.bat_err[d.has_battery & d.pred_has_bat].mean()),
        "P10-P90 cover %": g.apply(lambda d: ((d.pv_kwp >= d.pv_lo - 1e-9) & (d.pv_kwp <= d.pv_hi + 1e-9))[d.has_pv & d.pred_has_pv].mean() * 100),
    }).round(2)


def main():
    out = ["# Error analysis (locked test set, shipped model)", ""]
    for answered in (False, True):
        t = run(answered)
        mode = "planner answered 'PV already on the roof?'" if answered else "not answered"
        out += [f"## Mode: {mode}", ""]
        for by in ("installer", "true_group", "band", "demand_is_default", "pv_source"):
            out += [f"### by {by}", "", seg_table(t, by).to_markdown(), ""]
        out += ["### offer type: true (rows) vs predicted (columns)", "",
                pd.crosstab(t.true_group, t.pred_type).to_markdown(), ""]
        if not answered:
            worst = t[t.has_pv].sort_values("pv_err", ascending=False).head(10)
            out += ["### 10 largest PV misses", "", worst[["installer", "annual_kwh", "demand_is_default", "has_ev",
                                                          "pv_kwp", "pred_pv", "pv_min", "pv_max", "pv_source",
                                                          "offer_type"]].round(2).to_markdown(index=False), ""]
    text = "\n".join(out)
    (ARTIFACTS / "error_analysis.md").write_text(text, encoding="utf-8")
    print(text)


if __name__ == "__main__":
    main()
