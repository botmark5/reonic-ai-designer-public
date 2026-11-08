"""
engine/ablation.py - before/after proof for each engine improvement on the LOCKED test set.

    python -m engine.ablation          -> prints a table, writes engine/artifacts/ablation.md

Every variant is trained on the same training projects and scored on the same locked test projects
(engine/artifacts/test_ids.json) against engine/labels' expert designs:
    A  before #1: no offer-type step, PV snapped to 450 W modules
    B  + #1  offer type (new system / retrofit / wallbox only / other) + "Is there already PV?" input
    C  + #3  PV snapped to the installer's standard packages
    D  + #5  conformal P10-P90 + learned retrofit weight
    E  + battery size: mean of classifier and installer kWh/kWp rule
    F  + every offer option of a training project is a training row; yes/no decisions on the first full design only
         (= the shipped model). "All options everywhere" is shown too: it loses 5 points on add-ons' "no new PV".
    (PV linear blend: tested, not shipped)
    #4 interim labels + raw inputs  vs  engine/labels + cleaned inputs  (both scored on engine/labels)
Columns: all projects without the existing-PV answer; full new-system designs WITH the answer (the planner knows it
is a new system); full designs with real consumption (answered).
"""
from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

from engine.evaluate import (ARTIFACTS, BandMedianBaseline, build_eval_table, build_train_table, compute_metrics,
                             inputs_from_labels, load_catalogue, load_inputs, locked_split, planner_answer)
from engine.interim_labels import build_interim_labels, get_labels
from engine.model import DesignModel

warnings.filterwarnings("ignore")
METRICS = [("PV kWp MAE, all projects", "pv_kwp_mae_all_projects", "{:.2f}"),
           ("PV kWp MAE, size only", "pv_kwp_mae_when_both_pv", "{:.2f}"),
           ("PV within ±1.5 kWp", "pv_kwp_within_1.5_pct", "{:.0f} %"),
           ("PV exact match", "pv_exact_pct", "{:.0f} %"),
           ("PV in expert variants ±1 kWp", "pv_variant_hit_tolerant_pct", "{:.0f} %"),
           ("battery kWh MAE, size only", "battery_kwh_mae_when_both_battery", "{:.2f}"),
           ("battery within 1 step", "battery_within_one_step_pct", "{:.0f} %"),
           ("PV kWp MAE vs nearest option", "pv_kwp_mae_nearest_option", "{:.2f}"),
           ("PV within ±1.5 kWp of nearest option", "pv_kwp_within_1.5_nearest_option_pct", "{:.0f} %"),
           ("top-3 within ±1.5 kWp", "pv_top3_within_1.5_pct", "{:.0f} %"),
           ("top-3 within ±1.5 kWp of nearest option", "pv_top3_within_1.5_nearest_option_pct", "{:.0f} %"),
           ("battery within 1 step of nearest option", "battery_within_one_step_nearest_option_pct", "{:.0f} %"),
           ("PV yes/no", "has_pv_accuracy", "{:.0f} %"),
           ("battery yes/no", "has_battery_accuracy", "{:.0f} %"),
           ("offer type", "offer_type_accuracy", "{:.0f} %"),
           ("P10–P90 contains expert PV (target 80 %)", "pv_interval_coverage_pct", "{:.0f} %")]


def score(model, test: pd.DataFrame, truth: pd.DataFrame, catalogue: dict) -> dict:
    """Metrics for one model: test = feature rows, truth = engine/labels rows (same project order)."""
    out = model._run(test)
    pred = out[["has_pv", "pv_kwp", "has_battery", "battery_kwh", "has_wallbox", "has_heatpump", "offer_type"]].copy()
    pred.index = truth.index
    m = compute_metrics(truth, pred, catalogue)
    both = truth.has_pv.to_numpy() & pred.has_pv.to_numpy()
    m["pv_exact_pct"] = float((np.abs(pred.pv_kwp.to_numpy() - truth.pv_kwp.to_numpy())[both] < 0.05).mean() * 100) if both.any() else None
    lo = np.minimum(out.pv_lo.to_numpy(), out.pv_kwp.to_numpy()) if "pv_lo" in out else np.minimum(out.pv_p10, out.pv_p90)
    hi = np.maximum(out.pv_hi.to_numpy(), out.pv_kwp.to_numpy()) if "pv_hi" in out else np.maximum(out.pv_p10, out.pv_p90)
    y = truth.pv_kwp.to_numpy()
    m["pv_interval_coverage_pct"] = float(((y >= lo - 1e-9) & (y <= hi + 1e-9))[both].mean() * 100) if both.any() else None
    return m


def views(model, test, truth, catalogue):
    answered = test.assign(existing_pv=planner_answer(truth).to_numpy())
    full = (truth.offer_type == "new_system").to_numpy()
    known = truth.consumption_known.fillna(False).astype(bool).to_numpy() if "consumption_known" in truth else full
    return {"all projects": score(model, test, truth, catalogue),
            "full designs (answered)": score(model, answered[full], truth[full], catalogue),
            "full + real consumption (answered)": score(model, answered[full & known], truth[full & known], catalogue)}


def main():
    labels, source = get_labels()
    assert "expert_designs" in source, "needs engine/labels expert_designs.parquet"
    inputs = inputs_from_labels(labels)
    table = build_eval_table(labels, inputs)
    train, test = locked_split(table, ARTIFACTS / "test_ids.json")
    cat = load_catalogue(labels)
    print(f"train {len(train)} / locked test {len(test)} projects")

    rows = {}
    variants = {"A  before #1 (no offer type, 450 W modules)": dict(offer_type=False, packages=False, calibrated=False, battery_mix=False),
                "B  + #1 offer type + existing-PV input": dict(offer_type=True, packages=False, calibrated=False, battery_mix=False),
                "C  + #3 installer packages": dict(offer_type=True, packages=True, calibrated=False, battery_mix=False),
                "D  + #5 calibration": dict(offer_type=True, packages=True, calibrated=True, battery_mix=False),
                "E  + battery kWh/kWp mix": dict(offer_type=True, packages=True, calibrated=True, battery_mix=True),
                "(PV linear blend, not shipped)": dict(offer_type=True, packages=True, calibrated=True, battery_mix=True,
                                                         blend=True)}
    for name, kw in variants.items():
        rows[name] = views(DesignModel(**kw).fit(train), test, test, cat)
        print("done:", name)
    # F: every offer option of a training project is a training row (Reonic, 8 Nov: all options are valid designs).
    # Shipped = hybrid: yes/no decisions learn from the first full design, sizes from all options.
    train_rows = build_train_table(labels, inputs, train)
    rows["(all options everywhere, not shipped)"] = views(DesignModel(primary_decisions=False).fit(train_rows), test, test, cat)
    rows["F  + all offer options: decide on first, size on all (shipped)"] = views(DesignModel().fit(train_rows), test, test, cat)
    print(f"done: F ({len(train_rows)} option rows of {len(train)} projects)")

    # #4: same model, trained on interim labels + raw inputs, scored against engine/labels
    interim = build_eval_table(build_interim_labels(), load_inputs())
    tr_i = interim[interim.project_id.isin(set(train.project_id))]
    te_i = interim.set_index("project_id").reindex(test.project_id).reset_index()
    ok = te_i.installer.notna().to_numpy()
    m_i = DesignModel().fit(tr_i)
    rows["#4 before: interim labels + raw inputs"] = views(m_i, te_i[ok].reset_index(drop=True),
                                                         test[ok].reset_index(drop=True), cat)
    base = BandMedianBaseline().fit(train)

    class Wrap:          # baseline in the same scoring path
        def _run(self, df):
            p = base.predict(df)
            return p.assign(offer_type=np.where(p.has_pv, "pv", "battery_retrofit"), pv_p10=p.pv_kwp, pv_p90=p.pv_kwp)
    rows["best baseline: band median"] = views(Wrap(), test, test, cat)

    lines = ["# Before/after on the locked test set", "",
             f"{len(test)} held-out projects (engine/artifacts/test_ids.json, grouped by customer), truth = engine/labels.", ""]
    for view in ("all projects", "full designs (answered)", "full + real consumption (answered)"):
        lines += [f"## {view}", "", "| metric | " + " | ".join(rows) + " |", "|---" * (len(rows) + 1) + "|"]
        for label, key, fmt in METRICS:
            vals = [rows[r][view].get(key) for r in rows]
            lines.append(f"| {label} | " + " | ".join("–" if v is None else fmt.format(v) for v in vals) + " |")
        lines.append("")
    text = "\n".join(lines)
    (ARTIFACTS / "ablation.md").write_text(text, encoding="utf-8")
    print(text)


if __name__ == "__main__":
    main()
