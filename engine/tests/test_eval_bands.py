"""by_band for GET /eval (issue #79): band assignment and per-band metrics on synthetic rows."""
import numpy as np
import pandas as pd

from engine.eval_bands import NOT_ENTERED, band_metrics, band_of


def _test():
    return pd.DataFrame({
        "project_id": list("abcde"), "installer": "i1",
        "annual_kwh": [2500, 3000, 4500, 4500, 12000], "demand_is_default": [False, False, False, True, False],
        "has_pv": [True, True, True, False, True], "pv_kwp": [6.0, 7.0, 9.0, 0.0, 20.0],
        "has_battery": [True, True, False, True, True], "battery_kwh": [5.0, 5.0, np.nan, 5.0, 10.0],
        "has_wallbox": False, "has_heatpump": False,
        "pv_min": [6.0, 7.0, 9.0, 0.0, 20.0], "pv_max": [6.0, 7.0, 9.0, 0.0, 20.0],
        "battery_min": [5.0, 5.0, 0.0, 5.0, 10.0], "battery_max": [5.0, 5.0, 0.0, 5.0, 10.0], "n_options": 1})


def test_band_of_is_right_closed_and_splits_out_the_default():
    assert band_of(_test()).tolist() == ["0-3000", "0-3000", "3000-4500", NOT_ENTERED, "9000+"]


def test_band_metrics_bias_sign_and_counts():
    t = _test()
    pred = pd.DataFrame({"has_pv": [True, True, True, True, True], "pv_kwp": [7.0, 6.0, 9.5, 8.0, 17.0],
                         "has_battery": True, "battery_kwh": 5.0, "has_wallbox": False, "has_heatpump": False}, index=t.index)
    out = band_metrics(t, {"design_model": pred}, {"i1": [5.0, 10.0]})
    assert list(out) == ["0-3000", "3000-4500", "9000+", NOT_ENTERED]
    low = out["0-3000"]["design_model"]
    assert low["n_projects"] == 2 and low["pv_kwp_mae_when_both_pv"] == 1.0 and low["pv_kwp_bias_when_both_pv"] == 0.0
    assert out["9000+"]["design_model"]["pv_kwp_bias_when_both_pv"] == -3.0           # we size smaller
    assert out[NOT_ENTERED]["design_model"]["has_pv_accuracy"] == 0.0                # proposed PV, expert sold none
    assert out[NOT_ENTERED]["design_model"]["pv_kwp_bias_when_both_pv"] is None
