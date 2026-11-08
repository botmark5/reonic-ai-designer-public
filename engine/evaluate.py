"""
engine/evaluate.py - evaluation harness: how close are designs to the experts', on projects never seen?

Independent of HOW the labels are built (engine/labels.py) and of WHICH model is used:
    * labels   = any table following the "Label table contract" in docs/data-notes.md
    * a model  = any object with .fit(train_df) and .predict(df) -> DataFrame of design columns

    python -m engine.evaluate --labels engine/artifacts/expert_designs.parquet

Protocol
    held-out : 80/20 split BY CUSTOMER / PROJECT (never by row), stratified by installer, seed 42
    transfer : train on installer A, test on installer B (and B -> A)
    truth    : the primary option of each project; the min/max over ALL its options = "variant range";
               *_nearest_option metrics score against the closest of the project's options (Reonic, 8 Nov 2026:
               the export has no signed flag and no proxy for it, every option is a valid planner's design)
    training : ALL offer options of the training projects (exact duplicates dropped), see build_train_table
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.model_selection import train_test_split

ENGINE_DIR = Path(__file__).resolve().parent
REPO_DIR = ENGINE_DIR.parent
RAW_DIR = REPO_DIR / "data" / "raw"
ARTIFACTS = ENGINE_DIR / "artifacts"
SEED = 42

# ---------------------------------------------------------------------------
# Label table contract (mirrored in docs/data-notes.md) - one row per project x offer option
# ---------------------------------------------------------------------------
REQUIRED_LABEL_COLUMNS = {
    "project_id": "str", "installer": "str", "option_number": "int", "is_primary": "bool",
    "has_pv": "bool", "pv_kwp": "float (0 if no PV)",
    "has_battery": "bool", "battery_kwh": "float (0 if no battery)",
    "has_wallbox": "bool", "has_heatpump": "bool", "heatpump_kw": "float (0 if none)",
}
OPTIONAL_LABEL_COLUMNS = {"wallbox_kw": "float", "inverter_kw": "float", "option_id": "str"}
DESIGN_COLUMNS = ["has_pv", "pv_kwp", "has_battery", "battery_kwh", "has_wallbox", "has_heatpump"]
BOOL_COMPONENTS = ["has_pv", "has_battery", "has_wallbox", "has_heatpump"]

PV_TOLERANCE_KWP = 1.0          # variant hit: PV within [min - 1, max + 1] kWp
BATTERY_TOLERANCE_STEPS = 1     # variant hit: battery within one catalogue step of the range
CONSUMPTION_BANDS_KWH = [0, 2500, 3500, 4500, 5500, 7000, 9000, np.inf]
MIN_COUNT_FOR_CATALOGUE = 5
MIN_COUNT_FOR_STEPS = 3          # catalogue.json sizes sold fewer times are not catalogue "steps"


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------
def load_labels(path: Path | str) -> pd.DataFrame:
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(f"Label table not found: {path}. It is produced by engine/labels.py (branch engine/labels).")
    df = normalize_labels(pd.read_parquet(path) if path.suffix == ".parquet" else pd.read_csv(path))
    validate_labels(df)
    return df


# Offer types (engine/labels v1.1 names) and the coarser groups the model decides between
OFFER_GROUP = {"new_system": "pv", "pv_extension": "pv", "battery_retrofit": "battery_retrofit",
               "wallbox_only": "wallbox_only", "heatpump_only": "other", "no_components": "other"}


def derive_offer_type(t: pd.DataFrame) -> pd.Series:
    """offer_type from the design (+ recorded existing PV), for labels that do not carry it (interim labels)."""
    existing = t["existing_pv"].fillna(0).astype(float) > 0 if "existing_pv" in t else pd.Series(False, index=t.index)
    return pd.Series(np.select(
        [t.has_pv & existing, t.has_pv, t.has_battery, t.has_wallbox, t.has_heatpump],
        ["pv_extension", "new_system", "battery_retrofit", "wallbox_only", "heatpump_only"], "no_components"),
        index=t.index)


def planner_answer(t: pd.DataFrame) -> pd.Series:
    """
    What a planner would answer to "Is there already PV on the roof?" for a TRAINING / TEST project:
    yes for battery retrofits and PV extensions (a battery without PV makes no sense), no for new systems,
    unknown for wallbox-only and other offers. Used to train the answered mode and to evaluate it.
    """
    yes = t.offer_type.isin(["battery_retrofit", "pv_extension"])
    no = t.offer_type == "new_system"
    return pd.Series(np.where(yes, 1.0, np.where(no, 0.0, np.nan)), index=t.index)


# engine/labels schema v1.1 uses battery / wallbox / heatpump and has no has_pv column
LABEL_ALIASES = {"battery": "has_battery", "wallbox": "has_wallbox", "heatpump": "has_heatpump"}


def normalize_labels(df: pd.DataFrame) -> pd.DataFrame:
    """
    Accept both label schemas: the contract above and engine/labels v1.1. Idempotent.
    - battery/wallbox/heatpump -> has_battery/has_wallbox/has_heatpump; has_pv = pv_kwp > 0
    - missing sizes (NaN = none in v1.1) -> 0
    - is_outlier (pv > 30 kWp or battery > 40 kWh, commercial size): those options are dropped, and a project
      whose primary option is an outlier is dropped entirely
    """
    df = df.copy()
    for src, dst in LABEL_ALIASES.items():
        if dst not in df.columns and src in df.columns:
            df[dst] = df[src].fillna(False).astype(bool)
    if "has_pv" not in df.columns and "pv_kwp" in df.columns:
        df["has_pv"] = df.pv_kwp.fillna(0) > 0
    for c in ("pv_kwp", "battery_kwh", "heatpump_kw"):
        if c in df.columns:
            df[c] = df[c].fillna(0.0)
    if "is_outlier" in df.columns:
        out = df.is_outlier.fillna(False).astype(bool)
        bad_projects = set(df.loc[out & df.is_primary.astype(bool), "project_id"])
        df = df[~out & ~df.project_id.isin(bad_projects)]
    return df.reset_index(drop=True)


def validate_labels(df: pd.DataFrame) -> None:
    """Raise a clear error if the table does not follow the label contract."""
    missing = [c for c in REQUIRED_LABEL_COLUMNS if c not in df.columns]
    if missing:
        raise ValueError(f"Label table is missing required columns: {missing}. "
                         f"Contract: {REQUIRED_LABEL_COLUMNS} (see docs/data-notes.md).")
    primaries = df.groupby("project_id")["is_primary"].sum()
    bad = primaries[primaries != 1]
    if len(bad):
        raise ValueError(f"Every project needs exactly one is_primary row; {len(bad)} projects do not "
                         f"(e.g. {list(bad.index[:3])}).")
    for c in ("pv_kwp", "battery_kwh", "heatpump_kw"):
        if (df[c].fillna(0) < 0).any():
            raise ValueError(f"Column {c} has negative values.")


def load_inputs(raw_dir: Path | str = RAW_DIR) -> pd.DataFrame:
    """Project inputs (the home before) from data/raw/<installer>/projects_status_quo.csv, api.md names."""
    frames = []
    for d in sorted(Path(raw_dir).iterdir()):
        f = d / "projects_status_quo.csv"
        if not f.exists():
            continue
        sq = pd.read_csv(f)
        frames.append(pd.DataFrame({
            "project_id": sq.project_id, "installer": d.name, "customer_contact_id": sq.customer_contact_id,
            "annual_kwh": sq.energy_demand_wh / 1000,
            "demand_is_default": sq.energy_demand_wh == 4_500_000,
            "consumption_known": (sq.energy_demand_wh != 4_500_000) & (sq.energy_demand_wh >= 1_500_000),
            "price_eur_kwh": sq.energy_price_per_wh * 1000,
            "load_profile": sq.load_profile, "has_ev": sq.has_ev.astype(bool),
            "ev_km_year": sq.ev_annual_drive_distance_km,
            "heating": sq.heating_existing_type,
            "heating_demand_kwh": sq.heating_existing_heating_demand_wh / 1000,
            # has_solar False in the data = "not answered", not "no": unknown (NaN) unless recorded True
            "existing_pv": sq.has_solar.astype(bool).map({True: 1.0, False: np.nan}),
            "existing_battery": sq.has_storage.astype(bool),
            "existing_wallbox": sq.has_wallbox.astype(bool),
            "offer_date": pd.to_datetime(sq.offer_created_at, format="mixed", errors="coerce"),
        }))
    if not frames:
        raise FileNotFoundError(f"No projects_status_quo.csv found under {raw_dir}.")
    return pd.concat(frames, ignore_index=True)


HOME_COLUMNS_V11 = {"annual_kwh_raw", "price_eur_kwh", "demand_is_default", "heating_type", "has_existing_wallbox"}


def inputs_from_labels(labels: pd.DataFrame) -> pd.DataFrame | None:
    """
    Home inputs from engine/labels' cleaned columns (schema v1.1), one row per project, api.md names.
    Consumption: invalid entries (< 1,500 kWh) -> unknown; the 4,500 kWh DEFAULT is kept with its flag
    (demand_is_default), because "planner left the default" is itself a strong signal (battery retrofits).
    Returns None when the labels carry no home columns (interim labels): use load_inputs() then.
    """
    if not HOME_COLUMNS_V11 <= set(labels.columns):
        return None
    p = labels[labels.is_primary.astype(bool)].drop_duplicates("project_id")
    annual = p.annual_kwh_raw.where(~p.demand_is_invalid.fillna(False).astype(bool))
    existing_pv = ((p.existing_pv_kwp.fillna(0) > 0) | p.has_solar.fillna(False).astype(bool)).map({True: 1.0, False: np.nan})
    return pd.DataFrame({
        "project_id": p.project_id.to_numpy(), "installer": p.installer.to_numpy(),
        "customer_contact_id": p.customer_contact_id.to_numpy(),
        "annual_kwh": annual.to_numpy(), "demand_is_default": p.demand_is_default.fillna(False).astype(bool).to_numpy(),
        "consumption_known": p.consumption_known.fillna(False).astype(bool).to_numpy(),
        "price_eur_kwh": p.price_eur_kwh.to_numpy(), "load_profile": p.load_profile.to_numpy(),
        "has_ev": p.has_ev.fillna(False).astype(bool).to_numpy(), "ev_km_year": p.ev_km_year.to_numpy(),
        "heating": p.heating_type.replace({"Unknown": None}).to_numpy(),
        "heating_demand_kwh": p.heating_demand_kwh.to_numpy(),
        "existing_pv": existing_pv.to_numpy(),
        "existing_battery": (p.existing_battery_kwh.fillna(0) > 0).to_numpy(),
        "existing_wallbox": p.has_existing_wallbox.fillna(False).astype(bool).to_numpy(),
        "offer_date": pd.to_datetime(p.offer_created_at, errors="coerce").to_numpy(),
    })


def load_catalogue(labels: pd.DataFrame, path: Path | str | None = ARTIFACTS / "catalogue.json") -> dict:
    """
    Battery sizes each installer sells: {installer: [sizes...]}.
    Uses engine/artifacts/catalogue.json if present ({inst: [..]} or {inst: {"battery_kwh": [..]}}),
    otherwise sizes that appear at least MIN_COUNT_FOR_CATALOGUE times in the labels.
    """
    if path is not None and Path(path).exists():
        raw = json.loads(Path(path).read_text())
        cat = {}
        for inst, v in raw.items():
            sizes = v.get("battery_kwh", []) if isinstance(v, dict) else v
            if isinstance(sizes, dict):                       # engine/labels v1.1: {size: how often sold}
                sizes = [k for k, n in sizes.items() if n >= MIN_COUNT_FOR_STEPS] or list(sizes)
            cat[inst] = sorted(float(x) for x in sizes if x and float(x) > 0)
        if cat:
            return cat
    cat = {}
    for inst, g in labels[labels.battery_kwh > 0].groupby("installer"):
        counts = g.battery_kwh.round(1).value_counts()
        sizes = counts[counts >= MIN_COUNT_FOR_CATALOGUE].index
        cat[inst] = sorted(float(s) for s in (sizes if len(sizes) else counts.index))
    return cat


# ---------------------------------------------------------------------------
# Evaluation table: primary design + inputs + variant ranges
# ---------------------------------------------------------------------------
def _option_sizes(s: pd.Series) -> tuple:
    """Distinct sizes over a project's options (0 = none), rounded to 0.01."""
    return tuple(sorted(set(float(x) for x in np.round(s.fillna(0).astype(float), 2))))


def build_eval_table(labels: pd.DataFrame, inputs: pd.DataFrame) -> pd.DataFrame:
    """One row per project: inputs, the primary (expert) design, the min/max and the distinct sizes over all options."""
    labels = normalize_labels(labels)
    validate_labels(labels)
    ranges = labels.groupby("project_id").agg(
        pv_min=("pv_kwp", "min"), pv_max=("pv_kwp", "max"),
        battery_min=("battery_kwh", "min"), battery_max=("battery_kwh", "max"),
        n_options=("option_number", "nunique"),
        pv_options=("pv_kwp", _option_sizes), battery_options=("battery_kwh", _option_sizes))
    primary = labels[labels.is_primary.astype(bool)]
    keep = ["project_id", "installer"] + [c for c in REQUIRED_LABEL_COLUMNS if c not in ("project_id", "installer",
                                                                                           "option_number", "is_primary")]
    keep += [c for c in ("offer_type",) if c in primary.columns]
    table = primary[keep].merge(ranges, on="project_id")
    # installer comes from the labels; the inputs only add the home's facts
    table = table.merge(inputs.drop(columns=["installer"], errors="ignore"), on="project_id", how="left")
    for c in BOOL_COMPONENTS:
        table[c] = table[c].astype(bool)
    if "offer_type" not in table.columns:
        table["offer_type"] = derive_offer_type(table)
    return table.reset_index(drop=True)


# ---------------------------------------------------------------------------
# Splits
# ---------------------------------------------------------------------------
TRAIN_DESIGN_COLUMNS = DESIGN_COLUMNS + ["heatpump_kw", "offer_type", "wallbox_kw", "inverter_kw"]


def build_train_table(labels: pd.DataFrame, inputs: pd.DataFrame, table: pd.DataFrame | None = None) -> pd.DataFrame:
    """
    The TRAINING rows: one row per offer option (exact duplicate options dropped) with its project's inputs.

    Reonic (Niklas, 8 Nov 2026) on the export: there is no signed flag and no reliable proxy for it (option numbers
    only count up, gaps are deleted options), and every option is a real planner's design for that home. So the model
    learns from all of them, while the evaluation truth stays one row per project (build_eval_table: primary row,
    variant range and the nearest-option metrics).
    `table` = build_eval_table(labels, inputs) or a subset of it (e.g. the training split): only its projects are kept.
    """
    table = build_eval_table(labels, inputs) if table is None else table
    lab = normalize_labels(labels)
    lab = lab[lab.project_id.isin(set(table.project_id))]
    if "is_duplicate_option" in lab.columns:                       # engine/labels: same items as a lower-numbered option
        lab = lab[~lab.is_duplicate_option.fillna(False).astype(bool)]
    else:                                                          # interim labels: same extracted design
        lab = lab.drop_duplicates(["project_id"] + [c for c in TRAIN_DESIGN_COLUMNS if c in lab.columns])
    design = [c for c in TRAIN_DESIGN_COLUMNS if c in table.columns and c in lab.columns]
    base = table.drop(columns=design).set_index("project_id")
    rows = lab[["project_id", "option_number", "is_primary"] + design].join(base, on="project_id")
    for c in BOOL_COMPONENTS + ["is_primary"]:
        rows[c] = rows[c].astype(bool)
    if "offer_type" not in lab.columns and "offer_type" in rows.columns:
        rows["offer_type"] = derive_offer_type(rows)               # per option, not the primary's type
    # is_primary marks the project's first full design: the model decides new system vs add-on on those rows only
    return rows[table.columns.tolist() + ["option_number", "is_primary"]].reset_index(drop=True)


def grouped_split(table: pd.DataFrame, test_size: float = 0.2, seed: int = SEED):
    """
    Split by CUSTOMER when customer_contact_id is known (41 customers have 2 projects), else by project_id:
    a project (and a customer's other project) is never in both parts. Stratified by installer when possible.
    """
    key = "customer_contact_id" if "customer_contact_id" in table.columns and table.customer_contact_id.notna().all() \
        else "project_id"
    ids = table[[key, "installer"]].drop_duplicates(key)
    strat = ids.installer if ids.installer.value_counts().min() >= 2 else None
    train_ids, test_ids = train_test_split(ids[key], test_size=test_size, random_state=seed, stratify=strat)
    return (table[table[key].isin(set(train_ids))].reset_index(drop=True),
            table[table[key].isin(set(test_ids))].reset_index(drop=True))


def locked_split(table: pd.DataFrame, path: Path | str | None, test_size: float = 0.2, seed: int = SEED):
    """
    The TEST set is fixed once (grouped by customer, seed 42) and saved to `path` (test_ids.json); every later
    run reuses it, so nothing is ever tuned on it. Projects not in the file (e.g. new labels) go to training.
    Delete the file to draw a new test set (e.g. when the label source changes).
    """
    if path is not None and Path(path).exists():
        test_ids = set(json.loads(Path(path).read_text())["test_project_ids"])
        return (table[~table.project_id.isin(test_ids)].reset_index(drop=True),
                table[table.project_id.isin(test_ids)].reset_index(drop=True))
    train, test = grouped_split(table, test_size, seed)
    if path is not None:
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        Path(path).write_text(json.dumps({"seed": seed, "grouped_by": "customer_contact_id",
                                          "test_project_ids": sorted(test.project_id)}, indent=0))
    return train, test


def segments(test: pd.DataFrame) -> dict:
    """Report slices (cala-physics-eval.md): new systems only, and homes with real (non-default) consumption."""
    seg = {}
    if "offer_type" in test:
        seg["full_designs"] = (test.offer_type == "new_system").to_numpy()
        seg["add_ons"] = (test.offer_type != "new_system").to_numpy()      # retrofits, extensions, wallbox-only, ...
    if "consumption_known" in test:
        seg["known_consumption"] = test.consumption_known.fillna(False).astype(bool).to_numpy()
    if "offer_type" in test and "consumption_known" in test:
        seg["full_designs_known_consumption"] = seg["full_designs"] & seg["known_consumption"]
    return seg


def installer_transfer(table: pd.DataFrame):
    """Train on one installer, test on another: [(name, train, test), ...] for every ordered pair."""
    insts = sorted(table.installer.unique())
    return [(f"{a}->{b}", table[table.installer == a].reset_index(drop=True),
             table[table.installer == b].reset_index(drop=True)) for a in insts for b in insts if a != b]


# ---------------------------------------------------------------------------
# Baselines (same interface as a real model)
# ---------------------------------------------------------------------------
def _band(kwh):
    return pd.cut(pd.Series(kwh).fillna(-1), CONSUMPTION_BANDS_KWH, right=False, labels=False)


def _mode(s, default):
    s = s.dropna()
    return s.mode().iloc[0] if len(s) else default


class KwhPer1000Baseline:
    """Rule of thumb: PV kWp = yearly kWh / 1000. Battery = installer's most common size. Yes/no = majority."""
    name = "baseline_kwh_per_1000"

    def fit(self, train: pd.DataFrame):
        self.global_ = self._stats(train)
        self.by_inst_ = {i: self._stats(g) for i, g in train.groupby("installer")}
        return self

    @staticmethod
    def _stats(g):
        return {**{c: bool(g[c].mean() >= 0.5) if len(g) else False for c in BOOL_COMPONENTS},
                "battery_kwh": float(_mode(g.loc[g.has_battery, "battery_kwh"], 0.0))}

    def predict(self, df: pd.DataFrame) -> pd.DataFrame:
        rows = []
        for _, r in df.iterrows():
            st = self.by_inst_.get(r.installer, self.global_)       # unseen installer -> pooled statistics
            kwp = r.annual_kwh / 1000 if pd.notna(r.annual_kwh) else np.nan
            rows.append(dict(has_pv=st["has_pv"], pv_kwp=kwp if st["has_pv"] else 0.0,
                             has_battery=st["has_battery"], battery_kwh=st["battery_kwh"] if st["has_battery"] else 0.0,
                             has_wallbox=st["has_wallbox"], has_heatpump=st["has_heatpump"]))
        return pd.DataFrame(rows, index=df.index)


class BandMedianBaseline:
    """Median PV / most common battery / majority yes-no per installer x consumption band."""
    name = "baseline_band_median"

    def fit(self, train: pd.DataFrame):
        t = train.assign(band=_band(train.annual_kwh).values)
        self.cells_ = {k: self._stats(g) for k, g in t.groupby(["installer", "band"])}
        self.bands_ = {k: self._stats(g) for k, g in t.groupby("band")}
        self.inst_ = {k: self._stats(g) for k, g in t.groupby("installer")}
        self.global_ = self._stats(t)
        return self

    @staticmethod
    def _stats(g):
        return {**{c: bool(g[c].mean() >= 0.5) if len(g) else False for c in BOOL_COMPONENTS},
                "pv_kwp": float(g.loc[g.has_pv, "pv_kwp"].median()) if g.has_pv.any() else 0.0,
                "battery_kwh": float(_mode(g.loc[g.has_battery, "battery_kwh"], 0.0))}

    def predict(self, df: pd.DataFrame) -> pd.DataFrame:
        bands = _band(df.annual_kwh).values
        rows = []
        for (_, r), b in zip(df.iterrows(), bands):
            # most specific statistics available: installer x band -> installer -> band -> everything
            st = (self.cells_.get((r.installer, b)) or self.inst_.get(r.installer)
                  or self.bands_.get(b) or self.global_)
            rows.append(dict(has_pv=st["has_pv"], pv_kwp=st["pv_kwp"] if st["has_pv"] else 0.0,
                             has_battery=st["has_battery"], battery_kwh=st["battery_kwh"] if st["has_battery"] else 0.0,
                             has_wallbox=st["has_wallbox"], has_heatpump=st["has_heatpump"]))
        return pd.DataFrame(rows, index=df.index)


class RatioBaseline(KwhPer1000Baseline):
    """
    Installer's own rule: PV kWp = (median kWp per MWh of that installer) x yearly MWh. Learned from the
    training projects with PV and real consumption (~2 kWp/MWh; kWh/1000 undersizes by half).
    Battery = installer's most common size; yes/no = majority.
    """
    name = "baseline_kwp_per_mwh"

    def fit(self, train: pd.DataFrame):
        super().fit(train)
        ok = train.has_pv & (train.annual_kwh > 0)
        if "consumption_known" in train:
            ok &= train.consumption_known.fillna(False).astype(bool)
        ratio = (train.pv_kwp / (train.annual_kwh / 1000))[ok]
        self.ratio_global_ = float(ratio.median()) if len(ratio) else 2.0
        self.ratio_ = {i: float(r.median()) for i, r in ratio.groupby(train.installer[ok])}
        return self

    def predict(self, df: pd.DataFrame) -> pd.DataFrame:
        out = super().predict(df)
        ratio = df.installer.map(self.ratio_).fillna(self.ratio_global_)
        out["pv_kwp"] = np.where(out.has_pv, ratio * df.annual_kwh.fillna(4500) / 1000, 0.0)
        return out


BASELINES = {KwhPer1000Baseline.name: KwhPer1000Baseline, BandMedianBaseline.name: BandMedianBaseline,
             RatioBaseline.name: RatioBaseline}


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------
def step_index(kwh, sizes) -> np.ndarray:
    """Catalogue step of each value: 0 = no battery, 1 = smallest size, ... (nearest size). NaN stays NaN."""
    steps = np.concatenate([[0.0], np.asarray(sorted(sizes), dtype=float)])
    v = np.asarray(kwh, dtype=float)
    idx = np.abs(np.nan_to_num(v, nan=0.0)[:, None] - steps[None, :]).argmin(axis=1).astype(float)
    idx[np.isnan(v)] = np.nan
    return idx


def _rate(mask) -> float | None:
    mask = np.asarray(mask, dtype=bool)
    return float(mask.mean() * 100) if mask.size else None


def _nearest_option_metrics(truth: pd.DataFrame, pred: pd.DataFrame, catalogue: dict) -> dict:
    """
    Errors against the NEAREST offer option of each project (min over its options). The honest size metric once
    no option is "the" signed one (Reonic, 8 Nov 2026); equals the primary metrics for single-option projects.
    """
    pv_pred = pred.pv_kwp.astype(float).fillna(0).to_numpy()
    b_pred = pred.battery_kwh.astype(float).fillna(0).to_numpy()
    e_all, e_pv, e_bat, step_ok = [], [], [], []
    for (_, t), pp, bp in zip(truth.iterrows(), pv_pred, b_pred):
        pv_opts = np.asarray(t.pv_options, dtype=float)
        b_opts = np.asarray(t.battery_options, dtype=float)
        e_all.append(float(np.abs(pp - pv_opts).min()))
        pv_opts, b_opts = pv_opts[pv_opts > 0], b_opts[b_opts > 0]
        if len(pv_opts) and pp > 0:
            e_pv.append(float(np.abs(pp - pv_opts).min()))
        if len(b_opts) and bp > 0:
            e_bat.append(float(np.abs(bp - b_opts).min()))
            sizes = catalogue.get(t.installer) or sorted(set(sum(catalogue.values(), [])))
            s = step_index([bp], sizes)[0]
            step_ok.append(min(abs(s - step_index([x], sizes)[0]) for x in b_opts) <= 1)
    e_pv = np.asarray(e_pv)
    top3 = None
    if {"pv_alt1", "pv_alt2"} <= set(pred.columns):          # proposal + 2 alternatives vs the nearest option with PV
        hits = []
        for (_, t), pp, a1, a2 in zip(truth.iterrows(), pv_pred, pred.pv_alt1.astype(float), pred.pv_alt2.astype(float)):
            opts = np.asarray(t.pv_options, dtype=float)
            opts = opts[opts > 0]
            if len(opts) and pp > 0:
                cands = np.array([v for v in (pp, a1, a2) if not pd.isna(v)])
                hits.append(np.abs(cands[:, None] - opts[None, :]).min() <= 1.5)
        top3 = _rate(hits) if hits else None
    return {"pv_kwp_mae_all_projects_nearest_option": float(np.mean(e_all)) if e_all else None,
            "pv_top3_within_1.5_nearest_option_pct": top3,
            "pv_kwp_mae_nearest_option": float(e_pv.mean()) if len(e_pv) else None,
            "pv_kwp_within_1.5_nearest_option_pct": _rate(e_pv <= 1.5) if len(e_pv) else None,
            "battery_kwh_mae_nearest_option": float(np.mean(e_bat)) if e_bat else None,
            "battery_within_one_step_nearest_option_pct": _rate(step_ok) if step_ok else None}


def compute_metrics(truth: pd.DataFrame, pred: pd.DataFrame, catalogue: dict) -> dict:
    """
    truth: rows of the eval table; pred: predictions with DESIGN_COLUMNS, same index.
    NaN predictions count as misses for rates and are excluded (and counted) for MAE.
    """
    pred = pred.reindex(truth.index)
    m: dict = {"n_projects": int(len(truth))}

    # yes/no accuracy per component
    for c in BOOL_COMPONENTS:
        p = pred[c]
        ok = (p.notna() & (p.astype(object) == truth[c].astype(object))).to_numpy()
        m[f"{c}_accuracy"] = _rate(ok)

    # PV size (projects where the expert installed PV)
    pv = truth.has_pv.to_numpy()
    err = (pred.pv_kwp.astype(float) - truth.pv_kwp)[pv]
    m["pv_kwp_mae"] = float(err.abs().mean()) if err.notna().any() else None
    m["pv_kwp_within_1.5_pct"] = _rate((err.abs() <= 1.5).to_numpy())
    m["pv_n"], m["pv_n_missing_pred"] = int(pv.sum()), int(err.isna().sum())
    # size error alone: projects where expert AND prediction include PV (separates "yes/no" from "how big")
    both = pv & (pred.pv_kwp.astype(float).fillna(0) > 0).to_numpy()
    e2 = (pred.pv_kwp.astype(float) - truth.pv_kwp)[both]
    m["pv_kwp_mae_when_both_pv"] = float(e2.abs().mean()) if len(e2) else None
    # fair end-to-end: ALL projects, "no PV" = 0 kWp on both sides, so an unwanted system also counts
    # (pv_kwp_mae above only scores projects WITH expert PV and never penalises PV proposed for a retrofit)
    e3 = (pred.pv_kwp.astype(float).fillna(0) - truth.pv_kwp.fillna(0)).abs()
    m["pv_kwp_mae_all_projects"] = float(e3.mean()) if len(e3) else None
    # P10-P90 coverage: share of projects (expert and model both PV) whose expert kWp lies inside the model's range
    if {"pv_lo", "pv_hi"} <= set(pred.columns):
        inside = ((truth.pv_kwp >= pred.pv_lo.astype(float) - 1e-9) & (truth.pv_kwp <= pred.pv_hi.astype(float) + 1e-9))
        m["pv_interval_coverage_pct"] = _rate(inside.to_numpy()[both]) if both.any() else None
    # top 3 = proposal + 2 alternatives: is the expert's PV among them (exactly / within 1.5 kWp)?
    if {"pv_alt1", "pv_alt2"} <= set(pred.columns):
        opts = np.stack([pred.pv_kwp.astype(float).to_numpy(), pred.pv_alt1.astype(float).to_numpy(),
                         pred.pv_alt2.astype(float).to_numpy()], axis=1)
        dist = np.abs(opts - truth.pv_kwp.to_numpy()[:, None])
        dist = np.where(np.isnan(dist), np.inf, dist)
        m["pv_top3_exact_pct"] = _rate((dist.min(axis=1) < 0.05)[both]) if both.any() else None
        m["pv_top3_within_1.5_pct"] = _rate((dist.min(axis=1) <= 1.5)[both]) if both.any() else None

    # battery size (projects where the expert installed a battery)
    bat = truth.has_battery.to_numpy()
    p_kwh = pred.battery_kwh.astype(float)
    err = (p_kwh - truth.battery_kwh)[bat]
    m["battery_kwh_mae"] = float(err.abs().mean()) if err.notna().any() else None
    within = []
    for (_, t), pk in zip(truth[bat].iterrows(), p_kwh[bat]):
        sizes = catalogue.get(t.installer) or sorted(set(sum(catalogue.values(), [])))
        if pd.isna(pk) or pk <= 0:                 # predicting "no battery" is a size miss
            within.append(False)
            continue
        d = abs(step_index([pk], sizes)[0] - step_index([t.battery_kwh], sizes)[0])
        within.append(d <= 1)
    m["battery_within_one_step_pct"] = _rate(within)
    m["battery_n"], m["battery_n_missing_pred"] = int(bat.sum()), int(err.isna().sum())
    both = bat & (p_kwh.fillna(0) > 0).to_numpy()
    e2 = (p_kwh - truth.battery_kwh)[both]
    m["battery_kwh_mae_when_both_battery"] = float(e2.abs().mean()) if len(e2) else None

    # variant-range hit rate (all projects; a single-option project's range is one point)
    pk = pred.pv_kwp.astype(float)
    m["pv_variant_hit_strict_pct"] = _rate((pk >= truth.pv_min - 1e-9) & (pk <= truth.pv_max + 1e-9))
    m["pv_variant_hit_tolerant_pct"] = _rate((pk >= truth.pv_min - PV_TOLERANCE_KWP) & (pk <= truth.pv_max + PV_TOLERANCE_KWP))
    strict, tolerant = [], []
    for (_, t), b in zip(truth.iterrows(), p_kwh):
        if pd.isna(b):                      # no prediction = miss
            strict.append(False)
            tolerant.append(False)
            continue
        strict.append(t.battery_min - 1e-9 <= b <= t.battery_max + 1e-9)
        sizes = catalogue.get(t.installer) or sorted(set(sum(catalogue.values(), [])))
        lo, hi, s = step_index([t.battery_min, t.battery_max, b], sizes)
        tolerant.append(lo - BATTERY_TOLERANCE_STEPS <= s <= hi + BATTERY_TOLERANCE_STEPS)
    m["battery_variant_hit_strict_pct"] = _rate(strict)
    m["battery_variant_hit_tolerant_pct"] = _rate(tolerant)
    m["n_multi_option_projects"] = int((truth.n_options > 1).sum())
    if {"pv_options", "battery_options"} <= set(truth.columns):
        m.update(_nearest_option_metrics(truth, pred, catalogue))
    if "offer_type" in pred.columns and "offer_type" in truth.columns:
        m["offer_type_accuracy"] = _rate((pred.offer_type == truth.offer_type.map(OFFER_GROUP)).to_numpy())
    return m


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------
def _evaluate_one(factory, train, test, catalogue, with_segments=False, train_rows=None):
    """train_rows: the option rows of the training projects (build_train_table); fits on `train` when None."""
    model = factory().fit(train if train_rows is None else train_rows)
    pred = model.predict(test) if len(test) else pd.DataFrame(columns=DESIGN_COLUMNS)
    missing = [c for c in DESIGN_COLUMNS if c not in pred.columns]
    if missing:
        raise ValueError(f"{getattr(model, 'name', model)} predict() must return columns {DESIGN_COLUMNS}; missing {missing}")
    overall = compute_metrics(test, pred, catalogue)
    by_inst = {i: compute_metrics(test[test.installer == i], pred[test.installer == i], catalogue)
               for i in sorted(test.installer.unique())}
    if with_segments:
        segs = {name: compute_metrics(test[mask], pred[mask], catalogue) for name, mask in segments(test).items()}
        return overall, by_inst, segs
    return overall, by_inst


def run_evaluation(labels: pd.DataFrame, predictors: dict, inputs: pd.DataFrame | None = None,
                   catalogue: dict | None = None, out_path: Path | str | None = ARTIFACTS / "eval_results.json",
                   test_size: float = 0.2, seed: int = SEED, test_ids_path: Path | str | None = None):
    """
    predictors: {name: factory} where factory() returns an object with fit/predict. Baselines are always added.
    Returns (tidy DataFrame, results dict shaped like GET /eval) and writes the dict to out_path.
    """
    if inputs is None:
        inputs = inputs_from_labels(labels)
        inputs = load_inputs() if inputs is None else inputs
    catalogue = catalogue if catalogue is not None else load_catalogue(labels)
    table = build_eval_table(labels, inputs)
    train, test = locked_split(table, test_ids_path, test_size, seed)
    assert not set(train.project_id) & set(test.project_id), "project leak between train and test"
    options = build_train_table(labels, inputs, table)          # every offer option, one row each

    def rows_of(projects):
        return options[options.project_id.isin(set(projects.project_id))].reset_index(drop=True)

    train_rows = rows_of(train)
    all_preds = {**BASELINES, **predictors}

    results = {"protocol": dict(split="grouped by customer_contact_id (else project_id), stratified by installer", test_size=test_size, seed=seed,
                                n_train=len(train), n_test=len(test), n_train_rows=len(train_rows),
                                training_rows="all offer options of the training projects, exact duplicates dropped",
                                pv_tolerance_kwp=PV_TOLERANCE_KWP,
                                battery_tolerance_steps=BATTERY_TOLERANCE_STEPS, catalogue=catalogue),
               "metrics": {}, "by_installer": {}, "segments": {}, "transfer": {}, "baselines": list(BASELINES)}
    rows = []
    for name, factory in all_preds.items():
        overall, by_inst, segs = _evaluate_one(factory, train, test, catalogue, with_segments=True, train_rows=train_rows)
        results["metrics"][name], results["by_installer"][name] = overall, by_inst
        for seg_name, mm in segs.items():
            results["segments"].setdefault(seg_name, {})[name] = mm
            rows += [dict(eval=f"held_out:{seg_name}", predictor=name, installer="all", metric=k, value=v)
                     for k, v in mm.items()]
        rows += [dict(eval="held_out", predictor=name, installer="all", metric=k, value=v) for k, v in overall.items()]
        for inst, mm in by_inst.items():
            rows += [dict(eval="held_out", predictor=name, installer=inst, metric=k, value=v) for k, v in mm.items()]
        for tname, tr, te in installer_transfer(table):
            mm, _ = _evaluate_one(factory, tr, te, catalogue, train_rows=rows_of(tr))
            results["transfer"].setdefault(tname, {})[name] = mm
            rows += [dict(eval=f"transfer {tname}", predictor=name, installer=te.installer.iloc[0] if len(te) else "",
                          metric=k, value=v) for k, v in mm.items()]
    if out_path is not None:
        Path(out_path).parent.mkdir(parents=True, exist_ok=True)
        Path(out_path).write_text(json.dumps(results, indent=2, default=float))
    return pd.DataFrame(rows), results


def summary_table(tidy: pd.DataFrame, eval_name: str = "held_out", installer: str = "all") -> pd.DataFrame:
    """Metrics as rows, predictors as columns (for printing)."""
    t = tidy[(tidy["eval"] == eval_name) & (tidy.installer == installer)]
    return t.pivot(index="metric", columns="predictor", values="value")


def main(argv=None):
    ap = argparse.ArgumentParser(description="Evaluate designs against expert labels.")
    ap.add_argument("--labels", default=str(ARTIFACTS / "expert_designs.parquet"))
    ap.add_argument("--raw-dir", default=str(RAW_DIR))
    ap.add_argument("--catalogue", default=str(ARTIFACTS / "catalogue.json"))
    ap.add_argument("--out", default=str(ARTIFACTS / "eval_results.json"))
    args = ap.parse_args(argv)
    try:
        labels = load_labels(args.labels)
    except FileNotFoundError as e:
        raise SystemExit(str(e))
    inputs = inputs_from_labels(labels)
    tidy, _ = run_evaluation(labels, {}, inputs=inputs if inputs is not None else load_inputs(args.raw_dir),
                             catalogue=load_catalogue(labels, args.catalogue), out_path=args.out)
    pd.set_option("display.width", 200)
    print("== held-out (all installers) ==")
    print(summary_table(tidy).round(2).to_string())
    for e in sorted(x for x in tidy["eval"].unique() if x.startswith("transfer")):
        print(f"\n== {e} ==")
        sub = tidy[tidy["eval"] == e]
        print(sub.pivot(index="metric", columns="predictor", values="value").round(2).to_string())
    print(f"\n[saved] {args.out}")


if __name__ == "__main__":
    main()
