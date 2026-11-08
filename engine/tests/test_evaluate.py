"""Tests for engine/evaluate.py: label contract, splits, baselines, metrics (hand-computed), runner."""
import json

import numpy as np
import pandas as pd
import pytest

from engine import evaluate as E

NAN = float("nan")


# ---------------------------------------------------------------- hand-computed 4-project example
@pytest.fixture
def tiny():
    truth = pd.DataFrame([
        # project, PV, PV range, battery, battery range, wallbox, options
        dict(project_id="p1", installer="X", has_pv=True, pv_kwp=10, pv_min=10, pv_max=10, has_battery=True,
             battery_kwh=10, battery_min=10, battery_max=10, has_wallbox=False, has_heatpump=False, n_options=1),
        dict(project_id="p2", installer="X", has_pv=True, pv_kwp=8, pv_min=8, pv_max=11, has_battery=True,
             battery_kwh=5, battery_min=5, battery_max=15, has_wallbox=True, has_heatpump=False, n_options=2),
        dict(project_id="p3", installer="X", has_pv=False, pv_kwp=0, pv_min=0, pv_max=0, has_battery=False,
             battery_kwh=0, battery_min=0, battery_max=0, has_wallbox=False, has_heatpump=False, n_options=1),
        dict(project_id="p4", installer="X", has_pv=True, pv_kwp=6, pv_min=6, pv_max=6, has_battery=True,
             battery_kwh=15, battery_min=15, battery_max=15, has_wallbox=False, has_heatpump=False, n_options=1),
    ])
    pred = pd.DataFrame([
        dict(has_pv=True, pv_kwp=10.5, has_battery=True, battery_kwh=10, has_wallbox=False, has_heatpump=False),
        dict(has_pv=True, pv_kwp=12.0, has_battery=True, battery_kwh=10, has_wallbox=False, has_heatpump=False),
        dict(has_pv=False, pv_kwp=0.0, has_battery=True, battery_kwh=5, has_wallbox=False, has_heatpump=False),
        dict(has_pv=True, pv_kwp=NAN, has_battery=False, battery_kwh=0, has_wallbox=False, has_heatpump=False),
    ])
    return truth, pred, {"X": [5.0, 10.0, 15.0]}


def test_metrics_hand_computed(tiny):
    m = E.compute_metrics(*tiny)
    assert m["has_pv_accuracy"] == 100
    assert m["has_battery_accuracy"] == 50
    assert m["has_wallbox_accuracy"] == 75
    assert m["has_heatpump_accuracy"] == 100
    assert m["pv_kwp_mae"] == pytest.approx(2.25)                # (0.5 + 4) / 2, NaN excluded ...
    assert m["pv_n"] == 3 and m["pv_n_missing_pred"] == 1        # ... and counted
    assert m["pv_kwp_within_1.5_pct"] == pytest.approx(100 / 3)  # NaN counts as a miss
    assert m["battery_kwh_mae"] == pytest.approx(20 / 3)         # (0 + 5 + 15) / 3
    assert m["battery_within_one_step_pct"] == pytest.approx(200 / 3)  # 10 vs 5 = 1 step; "none" vs 15 = miss
    assert m["pv_variant_hit_strict_pct"] == 25                  # only p3 (0 in [0, 0])
    assert m["pv_variant_hit_tolerant_pct"] == 75                # p1, p2 (+-1 kWp), p3; p4 NaN = miss
    assert m["battery_variant_hit_strict_pct"] == 50             # p1, p2
    assert m["battery_variant_hit_tolerant_pct"] == 75           # + p3 (5 kWh is one step above "none")
    assert m["n_multi_option_projects"] == 1


def test_metrics_empty_test_set(tiny):
    truth, pred, cat = tiny
    m = E.compute_metrics(truth.iloc[:0], pred.iloc[:0], cat)
    assert m["n_projects"] == 0 and m["pv_kwp_mae"] is None and m["has_pv_accuracy"] is None


def test_metrics_all_nan_predictions(tiny):
    truth, pred, cat = tiny
    nan_pred = pred.copy()
    for c in E.DESIGN_COLUMNS:
        nan_pred[c] = np.nan
    m = E.compute_metrics(truth, nan_pred, cat)
    assert m["has_pv_accuracy"] == 0 and m["pv_kwp_mae"] is None
    assert m["pv_variant_hit_tolerant_pct"] == 0 and m["battery_variant_hit_tolerant_pct"] == 0


def test_step_index():
    np.testing.assert_array_equal(E.step_index([0, 5, 7, 10, 14, 30], [5, 10, 15]), [0, 1, 1, 2, 3, 3])
    assert np.isnan(E.step_index([NAN], [5, 10])[0])


# ---------------------------------------------------------------- label contract
def test_validate_labels_ok(synthetic):
    E.validate_labels(synthetic[0])


def test_validate_labels_missing_columns(synthetic):
    with pytest.raises(ValueError, match="battery_kwh"):
        E.validate_labels(synthetic[0].drop(columns=["battery_kwh"]))


def test_validate_labels_two_primaries(synthetic):
    labels = synthetic[0].copy()
    labels["is_primary"] = True
    with pytest.raises(ValueError, match="exactly one is_primary"):
        E.validate_labels(labels)


def test_validate_labels_negative(synthetic):
    labels = synthetic[0].copy()
    labels.loc[0, "pv_kwp"] = -3
    with pytest.raises(ValueError, match="negative"):
        E.validate_labels(labels)


def test_eval_table_ranges(synthetic):
    labels, inputs = synthetic
    t = E.build_eval_table(labels, inputs)
    assert len(t) == labels.project_id.nunique()
    multi = t[t.n_options > 1].iloc[0]
    assert multi.pv_max - multi.pv_min == pytest.approx(1.5)      # option 2 has +1.5 kWp in the fixture
    assert (t.pv_min <= t.pv_kwp).all() and (t.pv_kwp <= t.pv_max).all()
    assert "annual_kwh" in t and t.annual_kwh.notna().all()


def test_load_labels_missing_file(tmp_path):
    with pytest.raises(FileNotFoundError, match="engine/labels.py"):
        E.load_labels(tmp_path / "nope.parquet")


def test_load_labels_parquet_roundtrip(synthetic, tmp_path):
    p = tmp_path / "labels.parquet"
    synthetic[0].to_parquet(p)
    assert len(E.load_labels(p)) == len(synthetic[0])


# ---------------------------------------------------------------- catalogue
def test_catalogue_from_labels(synthetic):
    cat = E.load_catalogue(synthetic[0], path=None)
    assert set(cat) == {"instA", "instB"}
    assert all(s > 0 for sizes in cat.values() for s in sizes)


@pytest.mark.parametrize("content", [{"instA": [5, 10]}, {"instA": {"battery_kwh": [5, 10], "pv_kwp": [6.3]}}])
def test_catalogue_from_json(synthetic, tmp_path, content):
    p = tmp_path / "catalogue.json"
    p.write_text(json.dumps(content))
    assert E.load_catalogue(synthetic[0], p) == {"instA": [5.0, 10.0]}


# ---------------------------------------------------------------- splits
def test_grouped_split_no_leak_and_stratified(synthetic):
    t = E.build_eval_table(*synthetic)
    train, test = E.grouped_split(t, test_size=0.2, seed=1)
    assert not set(train.project_id) & set(test.project_id)
    assert len(train) + len(test) == len(t)
    assert set(test.installer) == {"instA", "instB"}
    again, _ = E.grouped_split(t, test_size=0.2, seed=1)
    assert list(again.project_id) == list(train.project_id)          # fixed seed = same split


def test_installer_transfer(synthetic):
    t = E.build_eval_table(*synthetic)
    pairs = E.installer_transfer(t)
    assert [p[0] for p in pairs] == ["instA->instB", "instB->instA"]
    for _, tr, te in pairs:
        assert tr.installer.nunique() == 1 and te.installer.nunique() == 1
        assert tr.installer.iloc[0] != te.installer.iloc[0]


# ---------------------------------------------------------------- baselines
def test_kwh_per_1000_baseline(synthetic):
    t = E.build_eval_table(*synthetic)
    pred = E.KwhPer1000Baseline().fit(t).predict(t)
    assert set(E.DESIGN_COLUMNS) <= set(pred.columns)
    assert np.allclose(pred.pv_kwp, t.annual_kwh / 1000)


def test_band_median_baseline_learns_bands(synthetic):
    t = E.build_eval_table(*synthetic)
    pred = E.BandMedianBaseline().fit(t).predict(t)
    m = E.compute_metrics(t, pred, E.load_catalogue(synthetic[0], path=None))
    # the fixture's PV is a pure function of demand, so a band median is close
    assert m["pv_kwp_mae"] < 1.0


def test_baselines_handle_unseen_installer_and_missing_demand(synthetic):
    t = E.build_eval_table(*synthetic)
    new = t.head(3).assign(installer="never_seen", annual_kwh=[np.nan, 4000, 0])
    for cls in E.BASELINES.values():
        pred = cls().fit(t).predict(new)
        assert len(pred) == 3 and pred.has_pv.notna().all()


# ---------------------------------------------------------------- runner
class PerfectModel:
    """Cheats by reading the truth: every metric must be perfect."""
    name = "perfect"

    def fit(self, train):
        return self

    def predict(self, df):
        return df[E.DESIGN_COLUMNS].copy()


class BrokenModel:
    def fit(self, train):
        return self

    def predict(self, df):
        return pd.DataFrame({"pv_kwp": np.zeros(len(df))}, index=df.index)


def test_run_evaluation_end_to_end(synthetic, tmp_path):
    labels, inputs = synthetic
    out = tmp_path / "eval.json"
    tidy, res = E.run_evaluation(labels, {"perfect": PerfectModel}, inputs=inputs, out_path=out)
    assert out.exists() and json.loads(out.read_text())["protocol"]["n_test"] > 0
    assert set(res["metrics"]) == {"perfect", *E.BASELINES}
    p = res["metrics"]["perfect"]
    assert p["pv_kwp_mae"] == 0 and p["battery_kwh_mae"] == 0 and p["has_wallbox_accuracy"] == 100
    assert p["pv_variant_hit_strict_pct"] == 100 and p["battery_variant_hit_strict_pct"] == 100
    assert set(res["transfer"]) == {"instA->instB", "instB->instA"}
    assert set(res["by_installer"]["perfect"]) == {"instA", "instB"}
    table = E.summary_table(tidy)
    assert "pv_kwp_mae" in table.index and "perfect" in table.columns


def test_run_evaluation_rejects_incomplete_predictions(synthetic):
    with pytest.raises(ValueError, match="must return columns"):
        E.run_evaluation(synthetic[0], {"broken": BrokenModel}, inputs=synthetic[1], out_path=None)


def test_cli_missing_labels_file(tmp_path):
    with pytest.raises(SystemExit, match="not found"):
        E.main(["--labels", str(tmp_path / "missing.parquet")])


@pytest.mark.skipif(not E.RAW_DIR.exists(), reason="real data not present (data/raw is never committed)")
def test_load_inputs_real_data():
    inp = E.load_inputs()
    assert inp.project_id.is_unique
    assert set(inp.installer) == {"installer_b", "installer_a"}
    assert len(inp) == 342 + 1277
    assert inp.annual_kwh.median() == pytest.approx(4500)


# ---------------------------------------------------------------- engine/labels schema v1.1 + customer split
def test_normalize_mark_schema(synthetic):
    labels = synthetic[0].rename(columns={"has_battery": "battery", "has_wallbox": "wallbox", "has_heatpump": "heatpump"})
    labels = labels.drop(columns=["has_pv"])
    labels["heatpump_kw"] = np.nan                               # v1.1: NaN = no heat pump
    labels["is_outlier"] = False
    labels.loc[labels.index[0], "is_outlier"] = True             # a primary option -> whole project dropped
    norm = E.normalize_labels(labels)
    E.validate_labels(norm)
    assert {"has_pv", "has_battery", "has_wallbox", "has_heatpump"} <= set(norm.columns)
    assert (norm.heatpump_kw == 0).all()
    assert labels.project_id.iloc[0] not in set(norm.project_id)
    assert E.normalize_labels(norm).equals(norm)                 # idempotent
    assert len(E.build_eval_table(labels, synthetic[1])) == labels.project_id.nunique() - 1


def test_split_groups_customers(synthetic):
    labels, inputs = synthetic
    inputs = inputs.assign(customer_contact_id=[f"c{i // 2}" for i in range(len(inputs))])   # 2 projects per customer
    t = E.build_eval_table(labels, inputs)
    train, test = E.grouped_split(t, seed=3)
    assert not set(train.customer_contact_id) & set(test.customer_contact_id)
    assert not set(train.project_id) & set(test.project_id)


# ---------------------------------------------------------------- Mark's review: cleaned inputs, ratio baseline, lock
def _v11_labels(synthetic):
    labels, inputs = synthetic
    lab = labels.merge(inputs[["project_id", "annual_kwh", "has_ev", "price_eur_kwh", "load_profile"]], on="project_id")
    return lab.assign(annual_kwh_raw=lab.annual_kwh, demand_is_default=lab.annual_kwh == 4500,
                      demand_is_invalid=False, consumption_known=lab.annual_kwh != 4500, heating_type="Unknown",
                      has_existing_wallbox=False, customer_contact_id=lab.project_id, ev_km_year=np.nan,
                      heating_demand_kwh=np.nan, has_solar=False, existing_pv_kwp=np.nan, existing_battery_kwh=np.nan,
                      offer_created_at="2025-06-01", offer_type="new_system")


def test_inputs_from_labels(synthetic):
    lab = _v11_labels(synthetic)
    inp = E.inputs_from_labels(lab)
    assert len(inp) == lab.project_id.nunique() and inp.heating.isna().all()       # "Unknown" -> unknown
    assert np.isnan(inp.existing_pv).all()                                         # not recorded -> unknown
    assert (inp.annual_kwh == 4500).any() and inp.demand_is_default.any()          # default kept, with its flag
    assert E.inputs_from_labels(synthetic[0]) is None                              # interim labels: no home columns


def test_ratio_baseline_learns_kwp_per_mwh(synthetic):
    t = E.build_eval_table(*synthetic)
    b = E.RatioBaseline().fit(t)
    assert b.ratio_global_ == pytest.approx(1000 / 450, rel=0.05)                 # fixture: kWp = kWh / 450
    pred = b.predict(t)
    m = E.compute_metrics(t, pred, E.load_catalogue(synthetic[0], path=None))
    assert m["pv_kwp_mae_when_both_pv"] < 0.5


def test_locked_split_is_reused(synthetic, tmp_path):
    t = E.build_eval_table(*synthetic)
    path = tmp_path / "test_ids.json"
    _, test1 = E.locked_split(t, path, seed=1)
    _, test2 = E.locked_split(t, path, seed=99)                                    # seed ignored once locked
    assert path.exists() and list(test1.project_id) == list(test2.project_id)


def test_segments_and_catalogue_counts(synthetic, tmp_path):
    t = E.build_eval_table(*synthetic).assign(consumption_known=True)
    seg = E.segments(t)
    assert {"full_designs", "known_consumption", "full_designs_known_consumption"} <= set(seg)
    p = tmp_path / "catalogue.json"
    p.write_text(json.dumps({"instA": {"battery_kwh": {"5": 10, "10": 4, "12.4": 1}}}))
    assert E.load_catalogue(synthetic[0], p) == {"instA": [5.0, 10.0]}              # sold < 3 times: not a step


def test_interval_coverage_metric(tiny):
    truth, pred, cat = tiny
    p = pred.assign(pv_lo=[9.0, 7.0, 0.0, 5.0], pv_hi=[11.0, 9.0, 0.0, 7.0])
    m = E.compute_metrics(truth, p, cat)
    assert m["pv_interval_coverage_pct"] == 100.0          # p1 10 in [9,11], p2 8 in [7,9]; p4 has no predicted size
    assert "pv_interval_coverage_pct" not in E.compute_metrics(truth, pred, cat)


# ---------------------------------------------------------------- Reonic, 8 Nov: every offer option is a valid design
def test_train_table_has_one_row_per_option(synthetic):
    labels, inputs = synthetic
    t = E.build_eval_table(labels, inputs)
    rows = E.build_train_table(labels, inputs, t)
    assert len(rows) == len(labels)                                   # the synthetic data has no duplicate options
    assert set(rows.columns) >= set(t.columns) | {"option_number", "is_primary"}
    assert rows.groupby("project_id").is_primary.sum().eq(1).all()    # the decisions still have one row per project
    multi = labels.groupby("project_id").size().loc[lambda s: s > 1].index
    assert (rows[rows.project_id.isin(multi)].groupby("project_id").pv_kwp.nunique() > 1).any()   # variant keeps its own size
    sub = E.build_train_table(labels, inputs, t.head(10))
    assert set(sub.project_id) == set(t.head(10).project_id)          # a split keeps only its own projects


def test_nearest_option_metrics(synthetic):
    labels, inputs = synthetic
    t = E.build_eval_table(labels, inputs)
    pred = t[E.DESIGN_COLUMNS].copy()
    second = labels[labels.option_number == 2].set_index("project_id").pv_kwp
    m = t.project_id.isin(second.index) & t.has_pv
    pred.loc[m, "pv_kwp"] = t.loc[m, "project_id"].map(second).to_numpy()   # predict the variant, not the first option
    res = E.compute_metrics(t, pred, E.load_catalogue(labels, None))
    assert res["pv_kwp_mae_nearest_option"] == 0.0                    # the variant is one of the expert's options
    assert res["pv_kwp_mae_when_both_pv"] > 0                         # but not the first one
    assert res["battery_within_one_step_nearest_option_pct"] == 100.0


def test_model_fits_option_rows(synthetic):
    from engine.model import DesignModel
    labels, inputs = synthetic
    t = E.build_eval_table(labels, inputs)
    rows = E.build_train_table(labels, inputs, t)
    model = DesignModel().fit(rows)
    assert model.n_train_ == t.project_id.nunique() and model.n_train_rows_ == len(rows)
    assert model.reference_.project_id.is_unique                      # similar homes: one row per project
    assert set(model.predict(t).columns) >= set(E.DESIGN_COLUMNS)
