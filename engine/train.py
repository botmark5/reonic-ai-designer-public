"""
engine/train.py - evaluate the design model honestly, then train the shipped model on all projects.

    python -m engine.train            # uses Mark's expert_designs.parquet if present, else interim labels
    python -m engine.train --rebuild  # re-parse the interim labels from data/raw

Steps
    1. labels (engine/labels or interim) + home inputs (data/raw) -> one row per project
    2. engine/evaluate.run_evaluation: held-out 20 % (by project) + installer transfer, vs. baselines
       -> engine/artifacts/eval_results.json   (served by GET /eval)
    3. fit DesignModel on ALL offer options of all projects -> engine/artifacts/design_model.joblib (served by the API)
       (Reonic, 8 Nov: no option is marked as signed and each one is a valid design, so every option is a training row)
       The metrics in step 2 come from a model that never saw the test projects.
"""
from __future__ import annotations

import argparse
import json
import time
import warnings

import pandas as pd

from engine.evaluate import (ARTIFACTS, BASELINES, build_eval_table, build_train_table, inputs_from_labels, load_inputs,
                             planner_answer, run_evaluation, summary_table)
from engine.interim_labels import build_catalogue, get_labels
from engine.eval_bands import compute_by_band
from engine.model import MODEL_PATH, DesignModel

warnings.filterwarnings("ignore", message="X does not have valid feature names")

HEADLINE = ["pv_kwp_mae", "pv_kwp_mae_when_both_pv", "pv_kwp_mae_all_projects", "pv_kwp_within_1.5_pct", "pv_variant_hit_tolerant_pct", "battery_kwh_mae",
            "battery_kwh_mae_when_both_battery", "battery_within_one_step_pct", "battery_variant_hit_tolerant_pct",
            "pv_kwp_mae_nearest_option", "pv_kwp_within_1.5_nearest_option_pct", "battery_within_one_step_nearest_option_pct", "has_pv_accuracy",
            "has_battery_accuracy", "has_wallbox_accuracy", "has_heatpump_accuracy", "n_projects"]


def main(argv=None):
    ap = argparse.ArgumentParser(description="Evaluate and train the design model.")
    ap.add_argument("--rebuild", action="store_true", help="re-parse interim labels from data/raw")
    args = ap.parse_args(argv)
    t0 = time.time()

    labels, source = get_labels(rebuild=args.rebuild)
    inputs = inputs_from_labels(labels)
    inputs_source = "cleaned home columns of the label parquet" if inputs is not None else "data/raw status quo"
    inputs = inputs if inputs is not None else load_inputs()
    test_ids = ARTIFACTS / ("test_ids.json" if "expert_designs" in source else "test_ids_interim.json")
    catalogue = build_catalogue(labels)
    (ARTIFACTS / "catalogue_used.json").write_text(json.dumps(catalogue, indent=2))
    print(f"[labels] {source}: {len(labels)} options, {labels.project_id.nunique()} projects; inputs: {inputs_source}")
    print(f"[test set] locked in {test_ids.name} (created on first run, never tuned on)")

    tidy, results = run_evaluation(labels, {DesignModel.name: DesignModel}, inputs=inputs,
                                   catalogue={k: v["battery_kwh"] for k, v in catalogue.items()},
                                   out_path=ARTIFACTS / "eval_results.json", test_ids_path=test_ids)
    results["labels_source"] = source

    # same evaluation, but the planner answered "Is there already PV on the roof?" (derived from the offer type)
    table = build_eval_table(labels, inputs)
    answers = dict(zip(table.project_id, planner_answer(table)))
    inputs_q = inputs.assign(existing_pv=inputs.project_id.map(answers))
    tidy_q, res_q = run_evaluation(labels, {DesignModel.name: DesignModel}, inputs=inputs_q,
                                   catalogue={k: v["battery_kwh"] for k, v in catalogue.items()}, out_path=None,
                                   test_ids_path=test_ids)
    results["with_existing_pv_answer"] = {k: res_q[k] for k in ("metrics", "by_installer", "segments")}
    # PV error per consumption band (issue #79, /reality "Where we differ"), without the answer like `metrics`
    results["by_band"] = compute_by_band(labels, inputs, {k: v["battery_kwh"] for k, v in catalogue.items()}, test_ids)
    (ARTIFACTS / "eval_results.json").write_text(json.dumps(results, indent=2, default=float))

    pd.set_option("display.width", 200)
    cols = [DesignModel.name] + list(BASELINES)
    print("\n=== held-out projects (never seen in training), all installers ===")
    print(summary_table(tidy).loc[HEADLINE + ["offer_type_accuracy"], cols].round(2).to_string())
    for seg in ("full_designs", "full_designs_known_consumption", "add_ons", "known_consumption"):
        if f"held_out:{seg}" in set(tidy["eval"]):
            print(f"\n=== held-out, segment: {seg} ===")
            print(summary_table(tidy, eval_name=f"held_out:{seg}").loc[HEADLINE, cols].round(2).to_string())
    print("\n=== same held-out projects, planner answered 'Is there already PV on the roof?' ===")
    print(summary_table(tidy_q).loc[HEADLINE + ["offer_type_accuracy"], [DesignModel.name]].round(2).to_string())
    for inst in sorted(labels.installer.unique()):
        print(f"\n--- held-out, installer {inst} ---")
        print(summary_table(tidy, installer=inst).loc[HEADLINE, cols].round(2).to_string())
    for name in sorted(results["transfer"]):
        print(f"\n=== transfer {name} (train on one installer, test on the other) ===")
        tr = pd.DataFrame(results["transfer"][name]).loc[HEADLINE, cols]
        print(tr.round(2).to_string())

    model = DesignModel().fit(build_train_table(labels, inputs))
    model.inputs_source_ = inputs_source
    model.labels_source_ = source
    model.save(MODEL_PATH)
    print(f"\n[saved] {MODEL_PATH} (trained on {model.n_train_rows_} offer options of {model.n_train_} projects), "
          f"eval_results.json  ({time.time() - t0:.0f}s)")


if __name__ == "__main__":
    main()
