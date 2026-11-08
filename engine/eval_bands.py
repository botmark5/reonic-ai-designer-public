"""
engine/eval_bands.py - PV error per consumption band for GET /eval `by_band` (issue #79, /reality "Where we differ").

    python -m engine.eval_bands    -> adds `by_band` to engine/artifacts/eval_results.json (no full retrain needed)

Called by engine/train.py too. Locked test set, WITHOUT the planner's existing-PV answer (same mode as `metrics`).
Bands = deck chart 2a / docs/pitch-facts.md: yearly consumption up to 3,000 / 4,500 / 6,000 / 9,000 kWh / above, and
homes whose consumption was left at the 4,500 kWh default get their own band ("not_entered") instead of polluting
3000-4500. Aggregates only, no project rows. Uses compute_metrics from engine/evaluate.py unchanged.
"""
from __future__ import annotations

import json
import warnings

import numpy as np
import pandas as pd

from engine.evaluate import ARTIFACTS, BASELINES, build_eval_table, compute_metrics, inputs_from_labels, locked_split

warnings.filterwarnings("ignore")

BAND_EDGES_KWH = [0, 3000, 4500, 6000, 9000, np.inf]          # right-closed, as engine/error_analysis.py
BAND_KEYS = ["0-3000", "3000-4500", "4500-6000", "6000-9000", "9000+"]
NOT_ENTERED = "not_entered"


def band_of(test: pd.DataFrame) -> pd.Series:
    """Band key per test row; homes left at the default demand -> "not_entered"."""
    band = pd.cut(test.annual_kwh, BAND_EDGES_KWH, labels=BAND_KEYS).astype(object)
    default = test.demand_is_default.fillna(False).astype(bool) if "demand_is_default" in test else False
    return band.where(~default, NOT_ENTERED)


def band_metrics(test: pd.DataFrame, preds: dict[str, pd.DataFrame], catalogue: dict) -> dict:
    """{band: {predictor: compute_metrics(...) + pv_kwp_bias_when_both_pv}} for every band with projects."""
    band = band_of(test)
    out = {}
    for key in BAND_KEYS + [NOT_ENTERED]:
        mask = (band == key).to_numpy()
        if not mask.any():
            continue
        truth = test[mask]
        out[key] = {}
        for name, pred in preds.items():
            p = pred.reindex(test.index)[mask]
            m = compute_metrics(truth, p, catalogue)
            both = truth.has_pv.to_numpy() & (p.pv_kwp.astype(float).fillna(0) > 0).to_numpy()
            diff = (p.pv_kwp.astype(float) - truth.pv_kwp)[both]
            m["pv_kwp_bias_when_both_pv"] = float(diff.mean()) if len(diff) else None   # ours - expert
            out[key][name] = m
    return out


def compute_by_band(labels: pd.DataFrame, inputs: pd.DataFrame, catalogue: dict, test_ids_path) -> dict:
    from engine.model import DesignModel

    table = build_eval_table(labels, inputs)
    train, test = locked_split(table, test_ids_path)
    preds = {DesignModel.name: DesignModel().fit(train).predict(test)}
    for name, factory in BASELINES.items():
        preds[name] = factory().fit(train).predict(test)
    return band_metrics(test, preds, catalogue)


def main() -> None:
    from engine.interim_labels import build_catalogue, get_labels

    labels, source = get_labels()
    inputs = inputs_from_labels(labels)
    test_ids = ARTIFACTS / ("test_ids.json" if "expert_designs" in source else "test_ids_interim.json")
    catalogue = {k: v["battery_kwh"] for k, v in build_catalogue(labels).items()}
    path = ARTIFACTS / "eval_results.json"
    results = json.loads(path.read_text())
    results["by_band"] = compute_by_band(labels, inputs, catalogue, test_ids)
    path.write_text(json.dumps(results, indent=2, default=float))
    for key, block in results["by_band"].items():
        m, b = block["design_model"], block["baseline_band_median"]
        print(f"{key:<12} n={m['n_projects']:>3}  PV MAE both {m['pv_kwp_mae_when_both_pv'] or float('nan'):.2f} "
              f"(band median {b['pv_kwp_mae_when_both_pv'] or float('nan'):.2f})  bias {m['pv_kwp_bias_when_both_pv'] or 0:+.2f}  "
              f"PV yes/no {m['has_pv_accuracy']:.0f} %")
    print(f"-> by_band added to {path}")


if __name__ == "__main__":
    main()
