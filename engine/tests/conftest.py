"""Shared fixtures: synthetic labels + inputs, so the tests never need the (uncommitted) real data."""
import numpy as np
import pandas as pd
import pytest


def make_synthetic(n_per_installer=40, seed=0):
    """Two fake installers with a simple, learnable relation: PV ~ demand / 450, battery from a small catalogue."""
    rng = np.random.default_rng(seed)
    label_rows, input_rows = [], []
    for inst, sizes in [("instA", [5.0, 10.0, 15.0]), ("instB", [6.0, 9.0, 18.0])]:
        for i in range(n_per_installer):
            pid = f"{inst}_{i:03d}"
            kwh = float(rng.choice([2500, 3500, 4500, 6000, 8000]))
            input_rows.append(dict(project_id=pid, installer=inst, annual_kwh=kwh, has_ev=bool(i % 7 == 0),
                                   price_eur_kwh=0.35, load_profile="H0"))
            n_opt = 2 if i % 5 == 0 else 1
            for opt in range(1, n_opt + 1):
                has_pv = i % 10 != 9
                bat = sizes[min(int(kwh // 3000), 2)] if i % 8 != 7 else 0.0
                label_rows.append(dict(
                    project_id=pid, installer=inst, option_number=opt, is_primary=opt == 1,
                    has_pv=has_pv, pv_kwp=round(kwh / 450 + (opt - 1) * 1.5, 2) if has_pv else 0.0,
                    has_battery=bat > 0, battery_kwh=bat if opt == 1 else (sizes[-1] if bat else 0.0),
                    has_wallbox=bool(i % 7 == 0), has_heatpump=False, heatpump_kw=0.0))
    return pd.DataFrame(label_rows), pd.DataFrame(input_rows)


@pytest.fixture
def synthetic():
    return make_synthetic()
