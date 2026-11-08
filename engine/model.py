"""
engine/model.py - the design model: decides like an installer's planner.

Chain (decisions are coupled, like a planner thinks):
    1. heat pump  OPTION, not a default: the rule (physics.heatpump_recommendation) decides whether a heat pump
                  is OFFERED and which size; it is only included when the customer/planner chooses it (lock
                  heatpump_kw). Experts added one in only 11 of 24 gas/oil homes, so it is a budget/needs choice.
    2. PV yes/no + kWp (+ P10/P90)                        - sees total demand incl. EV + new heat pump
    3. battery yes/no + catalogue size                    - sees the PV size decided in step 2
    4. wallbox yes/no                                     - EV features only (barely predictable otherwise)
    Before 3: when there is NO new PV, an offer-type step decides battery retrofit / wallbox only / other.
    "Is there already PV on the roof?" (yes / no / unknown) is an input: every training project is used twice,
    once with the planner's answer (derived from its offer type) and once unanswered, so both modes work.
Locks: the planner can fix any component; everything AFTER it in the chain adapts.
Sizes snap to what the installer sells: batteries to its catalogue, PV to whole 450 W modules.

Interface for engine/evaluate.py: fit(table) / predict(df). For the API: propose(), similar_homes(), validate().
"""
from __future__ import annotations

from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from lightgbm import LGBMClassifier, LGBMRegressor
from sklearn.linear_model import HuberRegressor
from sklearn.model_selection import GroupKFold
from sklearn.preprocessing import StandardScaler

from engine import physics
from engine.evaluate import DESIGN_COLUMNS, OFFER_GROUP, derive_offer_type, planner_answer
from engine.features import build_features, clean_inputs, feature_text, offer_month
from engine.interim_labels import build_catalogue

ARTIFACTS = Path(__file__).resolve().parent / "artifacts"
MODEL_PATH = ARTIFACTS / "design_model.joblib"
MODULE_KWP = 0.45            # PV snaps to whole modules of 450 W ...
PACKAGE_MIN_SOLD = 10        # ... or to an exact kWp the installer sold >= 10 times (its standard packages)
PACKAGE_MAX_MOVE_KWP = 1.0   #     if that package is within 1 kWp (CV on training: exact matches 6.8 -> 10.5 %)
SEED = 42


def _lgb(**extra):
    """Small, conservative trees: ~1,300 training projects, so avoid overfitting."""
    p = dict(n_estimators=300, learning_rate=0.03, num_leaves=15, min_child_samples=15, subsample=0.8,
             subsample_freq=1, colsample_bytree=0.8, random_state=SEED, verbose=-1)
    p.update(extra)
    return p


class _MonotoneLinear:
    """
    Robust (Huber) linear PV-size model on standardised features, missing values -> training medians.
    total_demand_kwh is left out (collinear with annual_kwh; it got a negative weight), and the weights of the
    'increasing' features are clamped to >= 0, so more consumption or an EV can never shrink the PV.
    """

    def __init__(self, increasing: set):
        self.increasing = set(increasing)

    def fit(self, X: pd.DataFrame, y):
        cols = [c for c in X.columns if c != "total_demand_kwh" and X[c].astype(float).notna().mean() > 0.05]
        Xf = X[cols].astype(float)
        self.cols_, self.medians_ = cols, Xf.median().fillna(0)
        Z = Xf.fillna(self.medians_)
        self.scaler_ = StandardScaler().fit(Z)
        self.reg_ = HuberRegressor(max_iter=1000).fit(self.scaler_.transform(Z), np.asarray(y, dtype=float))
        for i, c in enumerate(cols):
            if c in self.increasing and self.reg_.coef_[i] < 0:
                self.reg_.coef_[i] = 0.0
        return self

    def predict(self, X: pd.DataFrame) -> np.ndarray:
        Z = X[self.cols_].astype(float).fillna(self.medians_)
        return self.reg_.predict(self.scaler_.transform(Z))


def package_kwp(note: str) -> float:
    """kWp from a package note like "the installer's standard 10.8 kWp package"."""
    import re
    m = re.search(r"([\d.]+) kWp package", note)
    return float(m.group(1)) if m else -1.0


def bracket_alternatives(sizes, proba, point: float, n: int, key: str, tol: float = 0.05) -> list[dict]:
    """
    The most likely size below `point` and the most likely size above it (planner request: "one smaller and one
    larger option next to the proposal"); if a side is empty, the next most likely other size fills the n slots.
    Returns [{key: size, "share": probability}] sorted by size; only sizes with a share > 0.
    """
    order = [k for k in np.argsort(proba)[::-1] if round(float(proba[k]), 2) > 0 and abs(sizes[k] - point) > tol]
    below = [k for k in order if sizes[k] < point]
    above = [k for k in order if sizes[k] > point]
    picks = ([below[0]] if below else []) + ([above[0]] if above else [])
    for k in order:
        if len(picks) >= n:
            break
        if k not in picks:
            picks.append(k)
    return sorted([{key: float(sizes[k]), "share": round(float(proba[k]), 2)} for k in picks[:n]], key=lambda a: a[key])


def snap_pv(kwp: float) -> float:
    return round(round(kwp / MODULE_KWP) * MODULE_KWP, 2) if kwp > 0 else 0.0


def nearest(value: float, sizes) -> float:
    return float(min(sizes, key=lambda s: abs(s - value)))


class DesignModel:
    name = "design_model"

    def __init__(self, offer_type: bool = True, packages: bool = True, learned_cutoffs: bool = True,
                 calibrated: bool = True, blend: bool = False, battery_mix: bool = True, primary_decisions: bool = True):
        """
        Switches exist to measure each improvement (before/after on the locked test set, engine/ablation.py):
          offer_type      : #1 new-vs-retrofit step + "Is there already PV?" answered/unanswered training
          packages        : #3 snap PV to the installer's standard packages (else whole 450 W modules)
          learned_cutoffs : PV / battery yes-no cut-offs learned out-of-fold (else 0.5)
          calibrated      : #5 conformal P10-P90 for PV + learned retrofit weight for the no-PV offer type
          blend           : PV size = LightGBM blended with a monotone linear model (weight learned by CV).
                            OFF by default: CV gain ~2 % (within fold noise), neutral on the locked test set and
                            fewer exact package matches (9 -> 7 %), so the simpler model is kept.
          battery_mix     : battery size = mean of the classifier and the installer's kWh-per-kWp rule when CV says so
          primary_decisions: with one training row per offer option (evaluate.build_train_table), the yes/no decisions
                            (new PV, offer type, battery, wallbox and their cut-offs) learn from the project's FIRST full
                            design only (is_primary); sizes, ranges, packages and alternatives learn from every option.
                            Reonic, 8 Nov: every option is a valid design, but a project with a retrofit AND a new-system
                            option would otherwise teach "new PV" and "no new PV" for the same home.
        The shipped model uses all of them.
        """
        self.use_primary_decisions = primary_decisions
        self.use_offer_type = offer_type
        self.use_packages = packages
        self.use_learned_cutoffs = learned_cutoffs
        self.use_calibration = calibrated
        self.use_blend = blend
        self.use_battery_mix = battery_mix

    # ------------------------------------------------------------------ training
    def fit(self, table: pd.DataFrame) -> "DesignModel":
        """
        table: inputs + an expert design per row. Shipped training: one row per offer option of each project
        (evaluate.build_train_table; Reonic, 8 Nov 2026: every option is a valid design and none is marked as signed).
        One row per project (evaluate.build_eval_table) works too and is what the baselines and older runs used.
        """
        t = clean_inputs(table)
        t = t[t.annual_kwh.notna()].reset_index(drop=True)          # no demand -> cannot learn from it
        self.installers_ = sorted(t.installer.unique())
        self.catalogue_ = build_catalogue(t, min_count=3)
        # new projects are dated "today", after all training data; the last months are unusual (April 2026 =
        # a batch of battery-only retrofits), so dates are capped at the 90th percentile of training dates
        has_dates = "offer_date" in t and t.offer_date.notna().any()
        self.offer_month_cap_ = float(offer_month(t.offer_date).quantile(0.9)) if has_dates else None

        if "offer_type" not in t.columns:
            t["offer_type"] = derive_offer_type(t)
        t["offer_group"] = t.offer_type.map(OFFER_GROUP).fillna("other")
        # every project twice: answered ("Is there already PV?") and unanswered (as recorded in the data)
        answered = t.assign(existing_pv=planner_answer(t))
        tt = pd.concat([answered, t], ignore_index=True) if self._on("use_offer_type") else t.copy()
        # rows for the yes/no decisions: the project's first full design (all rows when the table has one per project)
        prim_t = (t.is_primary.astype(bool).to_numpy() if "is_primary" in t and self._on("use_primary_decisions")
                  else np.ones(len(t), dtype=bool))
        prim = np.concatenate([prim_t, prim_t]) if self._on("use_offer_type") else prim_t
        X_p = lambda X: X[prim].reset_index(drop=True)                     # noqa: E731
        tt_p = tt[prim].reset_index(drop=True)

        # training uses the heat pump the expert actually installed ("with X kW heat pump, experts chose Y kWp")
        X = build_features(tt, tt.heatpump_kw, self.installers_, self.offer_month_cap_)
        self.features_ = list(X.columns)
        self.wallbox_features_ = [c for c in X.columns if c.startswith("inst_")] + ["has_ev", "ev_km", "existing_wallbox"]

        # 1. PV yes/no
        self.has_pv_ = LGBMClassifier(**_lgb()).fit(X[prim], tt.has_pv[prim].astype(int))
        self.pv_threshold_ = self._learn_pv_threshold(X_p(X), tt_p) if self._on("use_learned_cutoffs") else 0.5
        pv = tt.has_pv.astype(bool).to_numpy()

        # 1b. no new PV -> which kind of offer? (battery retrofit / wallbox only / other)
        nonpv = ~pv & prim
        groups = tt.offer_group[nonpv]
        if not self._on("use_offer_type"):
            self.nonpv_type_, self.nonpv_const_ = None, None
        elif groups.nunique() >= 2:
            self.nonpv_type_ = LGBMClassifier(**_lgb(min_child_samples=10)).fit(X[nonpv], groups)
            self.nonpv_const_ = None
        else:
            self.nonpv_type_, self.nonpv_const_ = None, (groups.iloc[0] if len(groups) else "battery_retrofit")

        # 2. PV size: simpler trees + Huber loss (robust to outliers like MAE) + monotonic constraints:
        # more consumption / an EV / more driving never makes the PV smaller (without them, the few EV
        # projects produced "EV added -> PV shrinks" artefacts). 5-fold CV MAE 2.60 kWp (band median: 2.69).
        # LightGBM allows monotonic constraints only with L2/Huber, not with MAE or quantile losses.
        increasing = {"total_demand_kwh", "annual_kwh", "has_ev", "ev_km"}
        pv_params = dict(num_leaves=7, min_child_samples=40, n_estimators=500, learning_rate=0.02)
        self.pv_ = LGBMRegressor(**_lgb(objective="huber", alpha=2.0, **pv_params,
                                        monotone_constraints=[1 if c in increasing else 0 for c in X.columns],
                                        monotone_constraints_method="advanced")).fit(X[pv], tt.pv_kwp[pv])
        # P10/P90 range (unconstrained; propose() widens the range so it always contains the point estimate)
        self.pv_q_ = {q: LGBMRegressor(**_lgb(objective="quantile", alpha=q / 100, **pv_params)).fit(X[pv], tt.pv_kwp[pv])
                      for q in (10, 90)}

        # 2b. a monotone linear model blended in: research CV on new systems, all 5 folds better (2.50 -> 2.45 kWp)
        self.pv_linear_ = _MonotoneLinear(increasing).fit(X[pv], tt.pv_kwp[pv])
        self.pv_blend_w_ = self._learn_blend_weight(X[pv], tt[pv].reset_index(drop=True), pv_params, increasing) \
            if getattr(self, "use_blend", False) else 0.0

        # 3. battery sees the EXPERT's PV during training (teacher forcing), our PV / the planner's lock at prediction
        Xb = X.assign(pv_kwp_planned=tt.pv_kwp.fillna(0).to_numpy())
        # battery yes/no is a decision for NEW PV systems; for a retrofit the battery is the offer itself
        bat_rows = (pv & prim) if self._on("use_offer_type") else prim          # old: one model for all homes
        self.has_battery_ = LGBMClassifier(**_lgb()).fit(Xb[bat_rows], tt.has_battery[bat_rows].astype(int))
        bat = tt.has_battery.astype(bool).to_numpy()
        y = [nearest(k, self.catalogue_[i]["battery_kwh"] or [k]) for k, i in zip(tt.battery_kwh[bat], tt.installer[bat])]
        # classes as whole tenths of a kWh (10.2 kWh -> 102): sklearn rejects float class labels
        self.battery_ = LGBMClassifier(**_lgb(min_child_samples=8)).fit(Xb[bat], np.round(np.asarray(y) * 10).astype(int))
        self.battery_kwh_ = self.battery_.classes_ / 10.0          # class index -> kWh
        # installer's own battery-per-PV rule (median kWh per kWp in new systems) and whether to blend it in
        nb = tt[tt.has_pv.astype(bool) & tt.has_battery.astype(bool) & (tt.offer_group == "pv")]
        self.battery_ratio_ = (nb.battery_kwh / nb.pv_kwp).groupby(nb.installer).median().to_dict()
        self.battery_mode_ = self._choose_battery_mode(Xb, tt) if self._on("use_battery_mix") else "classifier"

        # PV alternatives: a classifier over the sizes each installer really sells (>= 10x in new systems).
        # Only used for the 2 alternatives next to the regression's proposal (research CV: the expert's size is
        # within 1.5 kWp of one of the 3 options in 71 % of cases vs 54 % with the nearest sizes; exact 24 vs 21 %).
        self.pv_sizes_ = {}
        newpv = tt[tt.has_pv.astype(bool) & (tt.offer_group == "pv")]
        for i, g in newpv.groupby("installer"):
            vc = g.pv_kwp.round(2).value_counts()
            self.pv_sizes_[i] = np.array(sorted(float(k) for k, n in vc.items() if n >= 10))
        rows = (tt.has_pv.astype(bool) & (tt.offer_group == "pv") & tt.installer.map(lambda i: len(self.pv_sizes_.get(i, [])) > 0)).to_numpy()
        self.pv_size_clf_ = None
        if rows.sum() >= 50:
            sizes = [self.pv_sizes_[i][np.argmin(np.abs(self.pv_sizes_[i] - v))] for v, i in zip(tt.pv_kwp[rows], tt.installer[rows])]
            codes = np.round(np.asarray(sizes) * 100).astype(int)
            if len(set(codes)) >= 2:
                self.pv_size_clf_ = LGBMClassifier(**_lgb(num_leaves=7, min_child_samples=15, n_estimators=300)).fit(X[rows], codes)

        # 4. wallbox yes/no (all offers; "wallbox only" / "other" offers then fix it by their type).
        # Training it only on PV/retrofit offers was tested and was worse (70.6 vs 71.2 % held-out).
        self.wallbox_ = LGBMClassifier(**_lgb(num_leaves=7, min_child_samples=30)).fit(
            X[prim][self.wallbox_features_], tt.has_wallbox[prim].astype(int))

        # the installer's standard PV packages (exact kWp sold >= PACKAGE_MIN_SOLD times in new systems)
        newsys = t[t.has_pv & (t.offer_group == "pv")]
        self.packages_ = {i: sorted(float(k) for k, n in g.pv_kwp.round(2).value_counts().items() if n >= PACKAGE_MIN_SOLD)
                          for i, g in newsys.groupby("installer")}
        self.battery_threshold_ = self._learn_battery_threshold(t[prim_t].reset_index(drop=True)) if self._on("use_learned_cutoffs") else 0.5
        self.wallbox_mode_, self.wallbox_rule_rate_ = self._choose_wallbox_mode(X_p(X), tt_p)
        self.ev_uplift_kwp_ = self._learn_ev_uplift(X, tt, pv_params, increasing)
        on = self._on("use_calibration")
        self.retrofit_weight_ = self._learn_retrofit_weight(X_p(X), tt_p) if on and self.nonpv_type_ is not None else 1.0
        self.pv_margin_ = self._learn_pv_margin(X, tt, pv_params) if on else 0.0

        keep = ["project_id", "installer", "annual_kwh", "has_ev", "pv_kwp", "battery_kwh", "has_pv", "has_battery",
                "has_wallbox", "heatpump_kw"]
        X_orig = X.iloc[len(tt) - len(t):]
        ref = t[[c for c in keep if c in t]].assign(total_demand_kwh=X_orig.total_demand_kwh.to_numpy())
        # similar homes are looked up per project: keep one row per project (the first = the primary option)
        self.reference_ = ref.drop_duplicates("project_id") if "project_id" in ref else ref
        self.n_train_rows_ = len(t)
        self.n_train_ = int(t.project_id.nunique()) if "project_id" in t else len(t)
        return self

    def _on(self, flag: str) -> bool:
        return getattr(self, flag, True)          # models pickled before the switches existed: all on

    @staticmethod
    def _learn_pv_threshold(X: pd.DataFrame, t: pd.DataFrame) -> float:
        """
        Probability cut-off for "PV yes", chosen on OUT-OF-FOLD training predictions (never on test data).
        Objective = PV error in kWp, not plain accuracy, because the two mistakes are not equal:
            wrong "no PV"  -> the offer misses a whole system  (cost = the expert's kWp)
            wrong "PV yes" -> an unwanted system the planner removes (cost = a typical system, the median kWp)
        Ties go to the lower threshold. Falls back to 0.5 when there is too little data.
        """
        y = t.has_pv.astype(int).to_numpy()
        groups = (t.customer_contact_id if "customer_contact_id" in t else t.project_id).fillna(t.project_id)
        if len(t) < 100 or y.min() == y.max() or groups.nunique() < 5:
            return 0.5
        oof = np.zeros(len(t))
        for tr, te in GroupKFold(5).split(X, groups=groups):
            if len(set(y[tr])) < 2:
                return 0.5
            oof[te] = LGBMClassifier(**_lgb()).fit(X.iloc[tr], y[tr]).predict_proba(X.iloc[te])[:, 1]
        kwp = t.pv_kwp.fillna(0).to_numpy()
        typical = float(np.median(kwp[y == 1]))
        candidates = np.round(np.arange(0.20, 0.61, 0.05), 2)
        cost = [np.where((oof < c) & (y == 1), kwp, 0).sum() + ((oof >= c) & (y == 0)).sum() * typical
                for c in candidates]
        best = min(cost)
        return float(min(c for c, k in zip(candidates, cost) if k <= best + 1e-9))

    def _learn_battery_threshold(self, t: pd.DataFrame) -> float:
        """
        Cut-off for "battery yes" in NEW PV systems, chosen by accuracy on out-of-fold training predictions.
        ~96 % of new systems get a battery, so the best cut-off is usually low ("battery unless clearly not").
        """
        rows = t[t.offer_group == "pv"].reset_index(drop=True)
        y = rows.has_battery.astype(int).to_numpy()
        groups = (rows.customer_contact_id if "customer_contact_id" in rows else rows.project_id).fillna(rows.project_id)
        if len(rows) < 100 or y.min() == y.max() or groups.nunique() < 5:
            return 0.5
        X = build_features(rows, rows.heatpump_kw, self.installers_, self.offer_month_cap_)
        Xb = X.assign(pv_kwp_planned=rows.pv_kwp.fillna(0).to_numpy())
        oof = np.zeros(len(rows))
        for tr, te in GroupKFold(5).split(Xb, groups=groups):
            if len(set(y[tr])) < 2:
                return 0.5
            oof[te] = LGBMClassifier(**_lgb()).fit(Xb.iloc[tr], y[tr]).predict_proba(Xb.iloc[te])[:, 1]
        # 0.0 = the rule "always a battery" (the baseline); the model only wins if it is better on CV
        candidates = np.concatenate([[0.0], np.round(np.arange(0.05, 0.56, 0.05), 2)])
        acc = [((oof >= c) == y).mean() for c in candidates]
        return float(candidates[int(np.argmax(acc))])

    @staticmethod
    def _groups(t: pd.DataFrame) -> pd.Series:
        return (t.customer_contact_id if "customer_contact_id" in t else t.project_id).fillna(t.project_id)

    def _choose_wallbox_mode(self, X: pd.DataFrame, tt: pd.DataFrame) -> tuple[str, float]:
        """
        Wallbox yes/no: model, rule "EV -> wallbox" or rule "never", whichever is most accurate on out-of-fold
        training predictions (so the engine is never worse than the simple rule). Returns (mode, P(wallbox | EV)).
        """
        y = tt.has_wallbox.astype(bool).to_numpy()
        ev = (X.has_ev.to_numpy() == 1) & (X.existing_wallbox.to_numpy() == 0)
        rate = float(y[ev].mean()) if ev.any() else 0.5
        groups = self._groups(tt)
        if len(tt) < 100 or groups.nunique() < 5 or y.min() == y.max():
            return "ev_rule", rate
        oof = np.zeros(len(tt))
        for tr, te in GroupKFold(5).split(X, groups=groups):
            if len(set(y[tr])) < 2:
                return "ev_rule", rate
            m = LGBMClassifier(**_lgb(num_leaves=7, min_child_samples=30)).fit(X.iloc[tr][self.wallbox_features_], y[tr])
            oof[te] = m.predict_proba(X.iloc[te][self.wallbox_features_])[:, 1]
        acc = {"model": ((oof >= 0.5) == y).mean(), "ev_rule": (ev == y).mean(), "never": (~y).mean()}
        # ties go to the EV rule: it is explainable and is the planner's expectation
        best = max(acc.values())
        mode = "ev_rule" if acc["ev_rule"] >= best - 1e-9 else max(acc, key=acc.get)
        self.wallbox_cv_accuracy_ = {k: round(float(v) * 100, 1) for k, v in acc.items()}
        return mode, rate

    def _learn_ev_uplift(self, X, tt, pv_params, increasing) -> float:
        """
        Extra kWp experts give EV homes beyond what the size model predicts (median out-of-fold residual of EV homes,
        clipped to 0..3 kWp). The model alone barely reacts to an EV (few EV projects), experts add ~1-2 kWp.
        """
        rows = tt.has_pv.astype(bool).to_numpy()
        Xp, yp = X[rows], tt.pv_kwp.to_numpy()[rows]
        groups = self._groups(tt[rows].reset_index(drop=True))
        ev = Xp.has_ev.to_numpy() == 1
        if ev.sum() < 10 or groups.nunique() < 5:
            return 0.0
        oof = np.zeros(len(Xp))
        for tr, te in GroupKFold(5).split(Xp, groups=groups):
            m = LGBMRegressor(**_lgb(objective="huber", alpha=2.0, **pv_params,
                                     monotone_constraints=[1 if c in increasing else 0 for c in Xp.columns],
                                     monotone_constraints_method="advanced")).fit(Xp.iloc[tr], yp[tr])
            oof[te] = m.predict(Xp.iloc[te])
        return float(np.clip(np.median(yp[ev] - oof[ev]), 0.0, 3.0))

    def _learn_blend_weight(self, Xp: pd.DataFrame, tp: pd.DataFrame, pv_params: dict, increasing: set) -> float:
        """Weight of the linear model in the PV size blend: lowest out-of-fold MAE (after snapping) on training."""
        y = tp.pv_kwp.to_numpy()
        groups = self._groups(tp)
        if len(tp) < 100 or groups.nunique() < 5:
            return 0.0
        a, b = np.zeros(len(tp)), np.zeros(len(tp))
        for tr, te in GroupKFold(5).split(Xp, groups=groups):
            m = LGBMRegressor(**_lgb(objective="huber", alpha=2.0, **pv_params,
                                     monotone_constraints=[1 if c in increasing else 0 for c in Xp.columns],
                                     monotone_constraints_method="advanced")).fit(Xp.iloc[tr], y[tr])
            a[te] = m.predict(Xp.iloc[te])
            b[te] = _MonotoneLinear(increasing).fit(Xp.iloc[tr], y[tr]).predict(Xp.iloc[te])
        mae = {w: np.abs(np.array([snap_pv(v) for v in (1 - w) * a + w * b]) - y).mean() for w in (0.0, 0.3, 0.5, 0.7)}
        return float(min(mae, key=mae.get))

    def _choose_battery_mode(self, Xb: pd.DataFrame, tt: pd.DataFrame) -> str:
        """
        Battery size in new systems: the classifier alone, or the mean of the classifier and the installer's
        kWh-per-kWp rule, snapped to the catalogue. Lowest out-of-fold MAE on training wins
        (research CV: 2.35 -> 2.25 kWh, within one step 57 -> 61 %).
        """
        rows = (tt.has_pv.astype(bool) & tt.has_battery.astype(bool) & (tt.offer_group == "pv")).to_numpy()
        Xr, tr_ = Xb[rows], tt[rows].reset_index(drop=True)
        groups = self._groups(tr_)
        if len(tr_) < 100 or groups.nunique() < 5:
            return "classifier"
        y = tr_.battery_kwh.to_numpy()
        yc = np.round(np.array([nearest(k, self.catalogue_[i]["battery_kwh"] or [k])
                                for k, i in zip(tr_.battery_kwh, tr_.installer)]) * 10).astype(int)
        p_clf, p_mix = np.zeros(len(tr_)), np.zeros(len(tr_))
        for tr, te in GroupKFold(5).split(Xr, groups=groups):
            clf = LGBMClassifier(**_lgb(min_child_samples=8)).fit(Xr.iloc[tr], yc[tr])
            pc = clf.predict(Xr.iloc[te]) / 10
            a = tr_.iloc[tr]
            ratio = (a.battery_kwh / a.pv_kwp).groupby(a.installer).median()
            b = tr_.iloc[te]
            pr = b.installer.map(ratio).fillna(ratio.median()).to_numpy() * b.pv_kwp.to_numpy()
            p_clf[te] = pc
            p_mix[te] = [nearest((u + v) / 2, self.catalogue_.get(i, {}).get("battery_kwh") or [u])
                         for u, v, i in zip(pc, pr, b.installer)]
        return "mix" if np.abs(p_mix - y).mean() < np.abs(p_clf - y).mean() - 1e-9 else "classifier"

    def _learn_retrofit_weight(self, X: pd.DataFrame, tt: pd.DataFrame) -> float:
        """
        No new PV: battery retrofits are ~3x more common than wallbox-only orders, but the classifier picks
        "wallbox only" too often (error analysis). Weight on P(retrofit), chosen on out-of-fold predictions by
        accuracy of the resulting battery yes/no, among homes without new PV.
        """
        rows = (~tt.has_pv.astype(bool)).to_numpy()
        Xn, tn = X[rows], tt[rows].reset_index(drop=True)
        y = tn.offer_group.to_numpy()
        groups = self._groups(tn)
        if len(tn) < 60 or len(set(y)) < 2 or groups.nunique() < 5:
            return 1.0
        oof = pd.DataFrame(0.0, index=range(len(tn)), columns=["battery_retrofit", "wallbox_only", "other"])
        for tr, te in GroupKFold(5).split(Xn, groups=groups):
            if len(set(y[tr])) < 2:
                return 1.0
            clf = LGBMClassifier(**_lgb(min_child_samples=10)).fit(Xn.iloc[tr], y[tr])
            oof.loc[te, list(clf.classes_)] = clf.predict_proba(Xn.iloc[te])
        truth_bat = tn.has_battery.astype(bool).to_numpy()
        best_w, best_acc = 1.0, -1.0
        for w in (1.0, 1.5, 2.0, 3.0, 5.0, 8.0, 1e6):              # 1e6 = rule "no new PV -> battery retrofit"
            choice = oof.assign(battery_retrofit=oof.battery_retrofit * w).idxmax(axis=1).to_numpy()
            acc = ((choice == "battery_retrofit") == truth_bat).mean()
            if acc > best_acc + 1e-9:
                best_w, best_acc = w, acc
        return best_w

    def _learn_pv_margin(self, X: pd.DataFrame, tt: pd.DataFrame, pv_params: dict, target: float = 0.8) -> float:
        """
        Conformalized quantile regression: widen [P10, P90] by the margin that makes it contain `target` of the
        expert sizes in out-of-fold training predictions (raw quantile models covered only ~75 % on held-out data).
        """
        rows = tt.has_pv.astype(bool).to_numpy()
        Xp, tp = X[rows], tt[rows].reset_index(drop=True)
        y = tp.pv_kwp.to_numpy()
        groups = self._groups(tp)
        if len(tp) < 100 or groups.nunique() < 5:
            return 0.0
        lo, hi = np.zeros(len(tp)), np.zeros(len(tp))
        for tr, te in GroupKFold(5).split(Xp, groups=groups):
            for q, arr in ((10, lo), (90, hi)):
                m = LGBMRegressor(**_lgb(objective="quantile", alpha=q / 100, **pv_params)).fit(Xp.iloc[tr], y[tr])
                arr[te] = m.predict(Xp.iloc[te])
        lo, hi = np.minimum(lo, hi), np.maximum(lo, hi)
        score = np.maximum(lo - y, y - hi)                       # > 0 = outside the interval by that much
        level = min(1.0, target * (1 + 1 / len(score)))
        return float(max(0.0, np.quantile(score, level)))

    def pv_alternatives(self, X: pd.DataFrame, installers, points, caps=None, n: int = 2) -> list[list[dict]]:
        """
        For each home: the OTHER sizes this installer sells that the size classifier finds most likely, as a bracket
        around the proposal: the most likely size BELOW it and the most likely size ABOVE it (sorted ascending, with
        their share). When one side has nothing (smallest/largest size, roof cap) the next most likely size fills in.
        """
        clf = getattr(self, "pv_size_clf_", None)
        out = []
        if clf is None:
            return [[] for _ in range(len(X))]
        proba, kwp = clf.predict_proba(X), clf.classes_ / 100
        caps = caps if caps is not None else [np.inf] * len(X)
        for row, inst, p0, cap in zip(proba, installers, points, caps):
            allowed = np.isin(np.round(kwp, 2), np.round(self.pv_sizes_.get(inst, kwp), 2)) & (kwp <= cap + 1e-9)
            p = row * allowed
            if p.sum() <= 0:                       # nothing this installer sells fits (e.g. under the roof cap)
                out.append([])
                continue
            p = p / p.sum()
            out.append(bracket_alternatives(kwp, p, p0, n, "kwp"))
        return out

    def snap_pv_to_catalogue(self, kwp: float, installer: str) -> tuple[float, str | None]:
        """Standard package of this installer if within 1 kWp, else whole 450 W modules. Returns (kWp, package note)."""
        if kwp <= 0:
            return 0.0, None
        pkgs = getattr(self, "packages_", {}).get(installer, []) if self._on("use_packages") else []
        if pkgs:
            best = min(pkgs, key=lambda k: abs(k - kwp))
            if abs(best - kwp) <= PACKAGE_MAX_MOVE_KWP:
                return best, f"the installer's standard {best:g} kWp package"
        return snap_pv(kwp), None

    # ------------------------------------------------------------------ the chain
    def _heatpump(self, row) -> tuple[float, list[str], float]:
        cat = self.catalogue_.get(row.get("installer"), {})
        sells = cat.get("sells_heatpumps", True)
        sizes = cat.get("heatpump_kw") or list(physics.HP_CATALOGUE_KW)
        demand = row.get("heating_demand_kwh")
        demand = None if demand is None or pd.isna(demand) else float(demand)
        rec = physics.heatpump_recommendation(row.get("heating"), demand, sells, sizes)
        if rec["include"] and rec["kw"] is None:          # candidate, but heat demand unknown (issue #93: one consistent message)
            rec["kw"] = 10.0 if 10.0 in sizes else nearest(10, sizes)
            rec["reasons"] = [rec["reasons"][0],
                              f"Heating demand unknown: offered at {rec['kw']:g} kW, a mid-range size this installer sells. "
                              "Ask for the yearly gas or oil use to size it exactly (heat demand / 2,450 full-load hours)."]
        # gas/oil homes got a heat pump in ~11 of 24 cases at installer A -> a real choice, not a default
        conf = 0.5 if rec["include"] else 0.95
        return (rec["kw"] or 0.0) if rec["include"] else 0.0, rec["reasons"], conf

    def heatpump_option(self, home: dict, installer: str) -> dict:
        """Is a heat pump OFFERED for this home, and which size? (included only when chosen via the lock)"""
        kw, reasons, _ = self._heatpump(pd.Series(home_to_row(home, installer)))
        return dict(available=kw > 0, kw=kw or None, reasons=reasons)

    def _battery_proba(self, Xb: pd.DataFrame, installer: str) -> np.ndarray:
        """Battery size probabilities restricted to what THIS installer sells (snap to catalogue)."""
        proba = self.battery_.predict_proba(Xb)
        sizes = self.catalogue_.get(installer, {}).get("battery_kwh")
        if sizes:
            mask = np.isin(np.round(self.battery_kwh_, 1), np.round(sizes, 1))
            if mask.any():
                proba = proba * mask
                proba = proba / proba.sum(axis=1, keepdims=True)
        return proba

    def _run(self, homes: pd.DataFrame, locks: dict | None = None) -> pd.DataFrame:
        """Full chain for a table of homes. locks apply to every row (used by propose for one home)."""
        locks = {k: v for k, v in (locks or {}).items() if v is not None}
        out = pd.DataFrame(index=homes.index)
        # heat pump only when chosen (lock); otherwise it is offered as an option by propose()/the API
        out["heatpump_kw"] = float(locks.get("heatpump_kw", 0.0))
        X = build_features(homes, out.heatpump_kw.to_numpy(), self.installers_, self.offer_month_cap_)
        out["p_has_pv"] = self.has_pv_.predict_proba(X)[:, 1]
        w = getattr(self, "pv_blend_w_", 0.0)
        pv_tree = self.pv_.predict(X)
        pv_lin = self.pv_linear_.predict(X) if w > 0 else pv_tree
        out["pv_raw"] = (1 - w) * pv_tree + w * pv_lin + getattr(self, "ev_uplift_kwp_", 0.0) * (X.has_ev.to_numpy() == 1)
        out["pv_p10"], out["pv_p90"] = self.pv_q_[10].predict(X), self.pv_q_[90].predict(X)
        margin = getattr(self, "pv_margin_", 0.0)
        out["pv_lo"] = np.maximum(np.minimum(out.pv_p10, out.pv_p90) - margin, 0.0)
        out["pv_hi"] = np.maximum(out.pv_p10, out.pv_p90) + margin
        if "pv_kwp" in locks:
            out["has_pv"] = float(locks["pv_kwp"]) > 0
            out["pv_kwp"] = float(locks["pv_kwp"])
        else:
            out["has_pv"] = out.p_has_pv >= getattr(self, "pv_threshold_", 0.5)
            snapped = [self.snap_pv_to_catalogue(v, i)[0] for v, i in zip(out.pv_raw, homes.get("installer", [""] * len(homes)))]
            out["pv_kwp"] = np.where(out.has_pv, snapped, 0.0)
            # roof capacity (Google Solar): never propose more than the roof fits, whole 450 W panels
            cap = pd.to_numeric(homes.get("roof_max_kwp", pd.Series(np.nan, index=homes.index)), errors="coerce").to_numpy()
            capped = np.floor(np.nan_to_num(cap, nan=np.inf) / MODULE_KWP + 1e-9) * MODULE_KWP
            out["roof_capped"] = out.has_pv & (out.pv_kwp > capped + 1e-9)
            out["pv_kwp"] = np.where(out.roof_capped, np.round(capped, 2), out.pv_kwp)
            out["has_pv"] = out.has_pv & (out.pv_kwp > 0)
        # no new PV -> which kind of offer? (respecting locks: a locked battery means retrofit, etc.)
        if not self._on("use_offer_type"):
            return self._run_without_offer_type(homes, locks, out, X)
        if self.nonpv_type_ is not None:
            p_type = pd.DataFrame(self.nonpv_type_.predict_proba(X), columns=self.nonpv_type_.classes_, index=homes.index)
        else:
            p_type = pd.DataFrame({self.nonpv_const_: 1.0}, index=homes.index)
        for c in ("battery_retrofit", "wallbox_only", "other"):
            if c not in p_type:
                p_type[c] = 0.0
        if locks.get("battery_kwh"):
            p_type[["wallbox_only", "other"]] = 0.0
        elif "battery_kwh" in locks:
            p_type["battery_retrofit"] = 0.0
        if locks.get("wallbox") is False:
            p_type["wallbox_only"] = 0.0
        p_type = p_type.div(p_type.sum(axis=1).replace(0, 1), axis=0)
        weighted = p_type.assign(battery_retrofit=p_type.battery_retrofit * getattr(self, "retrofit_weight_", 1.0))
        nonpv_choice = weighted[["battery_retrofit", "wallbox_only", "other"]].idxmax(axis=1)
        out["offer_type"] = np.where(out.has_pv, "pv", nonpv_choice)
        out["p_offer_type"] = [1.0 if hp else float(p_type.loc[i, c]) for i, hp, c in zip(homes.index, out.has_pv, nonpv_choice)]

        Xb = X.assign(pv_kwp_planned=out.pv_kwp.to_numpy())
        p_bat_new = self.has_battery_.predict_proba(Xb)[:, 1]
        out["p_has_battery"] = np.where(out.offer_type == "pv", p_bat_new,
                                        np.where(out.offer_type == "battery_retrofit", 1.0, 0.0))
        sizes, probs = [], []
        mix = getattr(self, "battery_mode_", "classifier") == "mix"
        for idx, (_, r) in enumerate(homes.iterrows()):
            p = self._battery_proba(Xb.iloc[[idx]], r.get("installer"))[0]
            size = float(self.battery_kwh_[int(np.argmax(p))])
            pv_kwp = float(out.pv_kwp.iloc[idx])
            if mix and pv_kwp > 0 and r.get("installer") in self.battery_ratio_:
                rule = self.battery_ratio_[r.get("installer")] * pv_kwp           # installer's kWh-per-kWp rule
                cat = self.catalogue_.get(r.get("installer"), {}).get("battery_kwh") or [size]
                size = nearest((size + rule) / 2, cat)
            sizes.append(size)
            probs.append(p)
        out["battery_best"] = sizes
        if "battery_kwh" in locks:
            out["has_battery"] = float(locks["battery_kwh"]) > 0
            out["battery_kwh"] = float(locks["battery_kwh"])
        else:
            # new systems: learned cut-off (most get a battery); retrofit = 1, other = 0 (set above)
            out["has_battery"] = out.p_has_battery >= np.where(out.offer_type == "pv", getattr(self, "battery_threshold_", 0.5), 0.5)
            out["battery_kwh"] = np.where(out.has_battery, out.battery_best, 0.0)
        out["p_has_wallbox"] = self.wallbox_.predict_proba(X[self.wallbox_features_])[:, 1]
        mode = getattr(self, "wallbox_mode_", "model")
        ev = (X.has_ev.to_numpy() == 1) & (X.existing_wallbox.to_numpy() == 0)
        if mode == "ev_rule":
            base_wb = ev
            out["p_has_wallbox"] = np.where(ev, getattr(self, "wallbox_rule_rate_", 0.6), out.p_has_wallbox)
        elif mode == "never":
            base_wb = np.zeros(len(out), dtype=bool)
        else:
            base_wb = out.p_has_wallbox.to_numpy() >= 0.5
        if "wallbox" in locks:
            out["has_wallbox"] = bool(locks["wallbox"])
        else:
            out["has_wallbox"] = np.where(out.offer_type == "wallbox_only", True,
                                          np.where(out.offer_type == "other", False, base_wb))
        out["has_heatpump"] = out.heatpump_kw > 0
        self._last = dict(X=X, Xb=Xb, battery_proba=probs)        # kept for explanations of a single home
        return out

    def _run_without_offer_type(self, homes, locks, out, X):
        """The chain BEFORE improvement #1 (kept only for the before/after comparison)."""
        Xb = X.assign(pv_kwp_planned=out.pv_kwp.to_numpy())
        out["p_has_battery"] = self.has_battery_.predict_proba(Xb)[:, 1]
        sizes, probs = [], []
        for idx, (_, r) in enumerate(homes.iterrows()):
            p = self._battery_proba(Xb.iloc[[idx]], r.get("installer"))[0]
            sizes.append(float(self.battery_kwh_[int(np.argmax(p))]))
            probs.append(p)
        out["battery_best"] = sizes
        if "battery_kwh" in locks:
            out["has_battery"] = float(locks["battery_kwh"]) > 0
            out["battery_kwh"] = float(locks["battery_kwh"])
        else:
            out["has_battery"] = out.p_has_battery >= getattr(self, "battery_threshold_", 0.5)
            out["battery_kwh"] = np.where(out.has_battery, out.battery_best, 0.0)
        out["p_has_wallbox"] = self.wallbox_.predict_proba(X[self.wallbox_features_])[:, 1]
        out["has_wallbox"] = bool(locks["wallbox"]) if "wallbox" in locks else out.p_has_wallbox >= 0.5
        out["has_heatpump"] = out.heatpump_kw > 0
        out["offer_type"] = np.where(out.has_pv, "pv", np.where(out.has_battery, "battery_retrofit",
                                                                np.where(out.has_wallbox, "wallbox_only", "other")))
        out["p_offer_type"] = 1.0
        self._last = dict(X=X, Xb=Xb, battery_proba=probs)
        return out

    def predict(self, df: pd.DataFrame) -> pd.DataFrame:
        """Harness interface: predicted design per row (no locks)."""
        if len(df) == 0:
            return pd.DataFrame(columns=DESIGN_COLUMNS)
        out = self._run(df)
        # calibrated P10-P90 PV range (always contains the proposed size), for the coverage metric
        out["pv_lo"] = np.minimum(out.get("pv_lo", out.pv_kwp), out.pv_kwp)
        out["pv_hi"] = np.maximum(out.get("pv_hi", out.pv_kwp), out.pv_kwp)
        # two PV alternatives (for the "expert among our top 3" metric); NaN when none
        alts = self.pv_alternatives(self._last["X"], df.get("installer", pd.Series([""] * len(df))).tolist(),
                                    out.pv_kwp.tolist())
        out["pv_alt1"] = [a[0]["kwp"] if len(a) > 0 else np.nan for a in alts]
        out["pv_alt2"] = [a[1]["kwp"] if len(a) > 1 else np.nan for a in alts]
        return out[DESIGN_COLUMNS + ["offer_type", "pv_lo", "pv_hi", "pv_alt1", "pv_alt2"]]

    # ------------------------------------------------------------------ explanations
    def _drivers(self, model, X: pd.DataFrame, unit: str, class_index: int | None = None, top: int = 3) -> list[str]:
        """Top features behind ONE prediction (exact tree SHAP values via LightGBM pred_contrib)."""
        contrib = np.asarray(model.predict(X, pred_contrib=True))
        n = X.shape[1]
        if class_index is not None:
            contrib = contrib.reshape(len(X), -1, n + 1)[:, class_index, :]
        c = pd.Series(contrib[0, :n], index=X.columns)
        c = c[c.abs() > 1e-6]
        c = c.reindex(c.abs().sort_values(ascending=False).index).head(top)
        out = []
        for f, v in c.items():
            val = X.iloc[0][f]
            shown = ("" if f.startswith("inst_") else f" ({_fmt(f, val)})")
            out.append(f"{feature_text(f)}{shown} {'+' if v > 0 else ''}{v:.1f} kWp" if unit == "kWp"
                       else f"{feature_text(f)}{shown} speaks {'for' if v > 0 else 'against'} {unit}")
        return out

    # ------------------------------------------------------------------ API: one home
    def propose(self, home: dict, installer: str, locks: dict | None = None) -> dict:
        """Complete design for one home in docs/api.md shape (+ engine facts for the explanation)."""
        locks = {k: v for k, v in (locks or {}).items() if v is not None}
        row = pd.DataFrame([home_to_row(home, installer)])
        r = self._run(row, locks).iloc[0]
        X, Xb, proba = self._last["X"], self._last["Xb"], self._last["battery_proba"][0]
        classes = self.battery_kwh_
        design, facts = {}, {"locks": locks, "installer": installer}

        # heat pump: an option the customer chooses (budget / needs); included only when locked
        option = self.heatpump_option(home, installer)
        if locks.get("heatpump_kw"):
            hp_reasons = [f"Chosen by the customer/planner: {locks['heatpump_kw']:g} kW."] + option["reasons"][1:]
        elif "heatpump_kw" in locks:
            hp_reasons = ["Not chosen: no heat pump in this design."]
        elif option["available"]:
            hp_reasons = [f"Optional: a {option['kw']:g} kW heat pump can replace the {home.get('heating')} heating. "
                          "Not included by default; the customer decides based on budget and needs "
                          "(experts added one in about half of similar homes)."] + option["reasons"][1:]
        else:
            hp_reasons = option["reasons"]
        design["heatpump"] = dict(include=bool(r.heatpump_kw > 0), kw=float(r.heatpump_kw) or None,
                                  confidence=1.0 if "heatpump_kw" in locks else (0.5 if option["available"] else 0.95),
                                  reasons=hp_reasons, option=option)

        # PV
        lo, hi = float(r.pv_lo), float(r.pv_hi)                 # calibrated P10-P90 (~80 % of expert sizes)
        lo, hi = snap_pv(min(lo, r.pv_raw)), snap_pv(max(hi, r.pv_raw))
        if r.has_pv:                                   # the range always contains the proposed (snapped) size
            lo, hi = min(lo, float(r.pv_kwp)), max(hi, float(r.pv_kwp))
        if home.get("roof_max_kwp"):                   # ... and never goes above the roof capacity
            hi = min(hi, float(home["roof_max_kwp"]))
            lo = min(lo, hi)
        if "pv_kwp" in locks and r.has_pv:             # a planner's size above the roof cap stays inside its own range (flagged by physics)
            lo, hi = min(lo, float(r.pv_kwp)), max(hi, float(r.pv_kwp))
        if "pv_kwp" in locks:
            pv_reasons, pv_conf = [f"Fixed by the planner: {r.pv_kwp:g} kWp." if r.pv_kwp else "Fixed by the planner: no PV."], 1.0
        elif r.has_pv:
            pv_conf = float(r.p_has_pv)
            _, package = self.snap_pv_to_catalogue(float(r.pv_raw), installer)
            size_txt = package if package and abs(package_kwp(package) - r.pv_kwp) < 1e-6 else \
                f"~{round(r.pv_kwp / MODULE_KWP)} modules of 450 W"
            pv_reasons = [f"Model confidence {r.p_has_pv:.0%} that this home gets new PV; size {r.pv_kwp:g} kWp "
                          f"({size_txt}), typical range {lo:g}-{hi:g} kWp."]
            pv_reasons += ["Main drivers: " + "; ".join(self._drivers(self.pv_, X, "kWp")) + "."]
            if bool(r.get("roof_capped", False)):
                pv_reasons.append(f"Capped at the roof capacity: {home['roof_max_kwp']:g} kWp fits on the roof "
                                  f"(similar homes would get {snap_pv(float(r.pv_raw)):g} kWp).")
            if home.get("has_ev") and getattr(self, "ev_uplift_kwp_", 0) > 0:
                pv_reasons.append(f"Electric car: +{self.ev_uplift_kwp_:.1f} kWp, what installers added for EV homes "
                                  "beyond the consumption effect.")
        else:
            pv_conf = 1 - float(r.p_has_pv)
            kind = {"battery_retrofit": "a battery add-on to an existing PV system", "wallbox_only": "a wallbox-only order",
                    "other": "an order without PV or battery"}.get(r.offer_type, "an order without new PV")
            pv_reasons = [f"No new PV: this looks like {kind} (model confidence for new PV only {r.p_has_pv:.0%}).",
                          "Main drivers: " + "; ".join(self._drivers(self.has_pv_, X, "PV")) + "."]
        if "pv_kwp" not in locks and pd.isna(X.existing_pv.iloc[0]) and 0.1 < r.p_has_pv < 0.9:
            pv_reasons.append("Is there already PV on the roof? Answering this is the strongest signal for "
                              "'new system' vs. 'battery add-on'.")
        design["pv"] = dict(include=bool(r.has_pv), kwp=float(r.pv_kwp) if r.has_pv else None, range=[lo, hi],
                            confidence=round(pv_conf, 2), reasons=pv_reasons)
        if r.has_pv:
            cap = float(home["roof_max_kwp"]) if home.get("roof_max_kwp") else np.inf
            design["pv"]["alternatives"] = self.pv_alternatives(X, [installer], [float(r.pv_kwp)], [cap])[0]

        # battery
        cdf = np.cumsum(proba)
        b_lo = float(classes[min(np.searchsorted(cdf, 0.1), len(classes) - 1)])
        b_hi = float(classes[min(np.searchsorted(cdf, 0.9), len(classes) - 1)])
        best = int(np.argmax(proba))                    # the classifier's most likely catalogue size
        shown = float(r.battery_kwh) if r.has_battery else None     # the size actually proposed (after the kWh/kWp mix)
        if shown:                                       # the range always contains the proposed size
            b_lo, b_hi = min(b_lo, shown), max(b_hi, shown)
        # one smaller and one larger catalogue size around the proposal, with the classifier's share for each
        alternatives = bracket_alternatives(classes, proba, shown if shown else float(classes[best]), 2, "kwh")
        # (the proposed size is not in `alternatives`: those are the classifier's own other sizes; the range covers it)
        if "battery_kwh" in locks:
            b_reasons, b_conf = [f"Fixed by the planner: {r.battery_kwh:g} kWh." if r.battery_kwh else "Fixed by the planner: no battery."], 1.0
        elif r.has_battery and r.offer_type == "battery_retrofit":
            b_conf = float(r.p_offer_type * proba[best])
            b_reasons = [f"Battery add-on to the existing PV: {shown:g} kWh is the most likely catalogue size "
                         f"(model confidence {proba[best]:.0%}), range {b_lo:g}-{b_hi:g} kWh."]
        elif r.has_battery:
            b_conf = float(min(1.0, r.p_has_battery / max(getattr(self, "battery_threshold_", 0.5) * 2, 1e-9)) * proba[best])
            mixed = getattr(self, "battery_mode_", "classifier") == "mix"
            ratio = getattr(self, "battery_ratio_", {}).get(installer)
            if mixed and ratio and float(r.pv_kwp) > 0 and abs(shown - float(classes[best])) > 1e-9:
                rule = ratio * float(r.pv_kwp)
                size_txt = (f"size {shown:g} kWh: the model's most likely size is {classes[best]:g} kWh ({proba[best]:.0%}), "
                            f"the installer's rule of {ratio:.1f} kWh per kWp of PV gives {rule:.1f} kWh, and {shown:g} kWh "
                            f"is the catalogue size between the two")
            else:
                size_txt = f"size {shown:g} kWh is the most likely catalogue size ({proba[best]:.0%})"
            b_reasons = [f"Model confidence {r.p_has_battery:.0%} that this design includes a battery; {size_txt}, "
                         f"range {b_lo:g}-{b_hi:g} kWh.",
                         "Main drivers: " + "; ".join(self._drivers(self.battery_, Xb, f"{classes[best]:g} kWh", class_index=best)) + "."]
        elif r.offer_type != "pv" and not r.has_pv:
            # no new PV and not a battery add-on: a battery without any PV makes no sense (wallbox-only / other order)
            b_conf = 1 - float(r.p_has_battery)
            kind = {"wallbox_only": "a wallbox-only order", "other": "an order without PV or battery"}.get(r.offer_type, "an order without new PV")
            b_reasons = [f"No battery: this looks like {kind}, and a battery only pays next to PV. "
                         "Lock a battery size to add one as a retrofit to an existing system."]
        else:
            b_conf = 1 - float(r.p_has_battery)
            b_reasons = [f"No battery: model confidence for a battery is only {r.p_has_battery:.0%}.",
                         "Main drivers: " + "; ".join(self._drivers(self.has_battery_, Xb, "a battery")) + "."]
        design["battery"] = dict(include=bool(r.has_battery), kwh=float(r.battery_kwh) if r.has_battery else None,
                                 range=[b_lo, b_hi], confidence=round(b_conf, 2), reasons=b_reasons,
                                 alternatives=alternatives)

        # wallbox
        wb_kw = self.catalogue_.get(installer, {}).get("wallbox_kw", 11.0)
        if "wallbox" in locks:
            wb_reasons, wb_conf = [f"Fixed by the planner: {'wallbox' if locks['wallbox'] else 'no wallbox'}."], 1.0
        else:
            wb_conf = float(max(r.p_has_wallbox, 1 - r.p_has_wallbox))
            if getattr(self, "wallbox_mode_", "model") == "ev_rule" and home.get("has_ev"):
                wb_reasons = [f"Electric car: a wallbox is included ({getattr(self, 'wallbox_rule_rate_', 0.6):.0%} of "
                              "EV homes got one; this rule beat the model on training data)."]
            else:
                wb_reasons = [f"Model confidence {r.p_has_wallbox:.0%} for a wallbox. " +
                              ("Driven by the electric car." if home.get("has_ev")
                               else "No EV recorded; many customers still order one, so ask them.")]
        design["wallbox"] = dict(include=bool(r.has_wallbox), kw=wb_kw if r.has_wallbox else None,
                                 confidence=round(wb_conf, 2), reasons=wb_reasons)

        facts.update(offer_type=str(r.offer_type), existing_pv_known=bool(not pd.isna(X.existing_pv.iloc[0])),
                     total_demand_kwh=float(X.total_demand_kwh.iloc[0]),
                     probabilities=dict(pv=round(float(r.p_has_pv), 2), battery=round(float(r.p_has_battery), 2),
                                        wallbox=round(float(r.p_has_wallbox), 2)),
                     date_used=_fmt("offer_month", X.offer_month.iloc[0]))
        return dict(design=design, facts=facts)

    def similar_homes(self, home: dict, installer: str, k: int = 5, heatpump_kw: float = 0.0) -> pd.DataFrame:
        """Closest past projects of the same installer: total demand (log) and EV status."""
        ref = self.reference_[self.reference_.installer == installer]
        if ref.empty:
            ref = self.reference_
        total = build_features(pd.DataFrame([home_to_row(home, installer)]), [heatpump_kw], self.installers_).total_demand_kwh.iloc[0]
        total = total if total and total > 0 else 4500.0
        dist = np.abs(np.log(ref.total_demand_kwh.clip(lower=1) / total)) + 0.3 * (ref.has_ev.astype(bool) != bool(home.get("has_ev")))
        out = ref.assign(similarity=(1 / (1 + 3 * dist)).round(2)).loc[dist.nsmallest(k).index]
        return out

    def validate(self, home: dict, installer: str, design: dict, k: int = 40) -> list[dict]:
        """Where does a planner's design sit among the k most similar past projects? + physics checks."""
        sim = self.similar_homes(home, installer, k=k, heatpump_kw=float(design.get("heatpump_kw") or 0))
        flags = []
        for comp, key, unit, mask in [("pv", "pv_kwp", "kWp", sim.has_pv.astype(bool)),
                                      ("battery", "battery_kwh", "kWh", sim.has_battery.astype(bool))]:
            v = design.get(key)
            vals = sim.loc[mask, key]
            if v is None or len(vals) < 5:
                continue
            v = float(v)
            if v == 0:
                flags.append(dict(component=comp, level="info", percentile=None, code=f"{comp.upper()}_NONE",
                                  message=f"No {comp}: {len(vals)} of {len(sim)} similar homes got one."))
                continue
            pct = int(round((vals < v).mean() * 100 + (vals == v).mean() * 50))
            if pct >= 90 or pct <= 10:
                word = "Larger" if pct >= 90 else "Smaller"
                share = pct if pct >= 90 else 100 - pct
                flags.append(dict(component=comp, level="warn", percentile=pct, code=f"{comp.upper()}_UNUSUAL",
                                  message=f"{word} than {share}% of similar homes ({vals.quantile(.1):.1f}-{vals.quantile(.9):.1f} {unit} is usual)."))
            else:
                flags.append(dict(component=comp, level="ok", percentile=pct, code=f"{comp.upper()}_TYPICAL",
                                  message=f"Typical for similar homes ({vals.quantile(.1):.1f}-{vals.quantile(.9):.1f} {unit})."))
        system = physics.System(pv_kwp=float(design.get("pv_kwp") or 0), battery_kwh=float(design.get("battery_kwh") or 0),
                                heatpump_kw=float(design.get("heatpump_kw") or 0), wallbox=bool(design.get("wallbox")))
        for f in physics.sanity_flags(home_to_physics(home), system, hp_catalogue=self.heatpump_sizes(installer)):
            flags.append({**f, "percentile": None})
        return contextualise_pv_flags(flags)

    def heatpump_sizes(self, installer: str) -> tuple:
        """Heat pump sizes this installer sells (same list for the option and the physics checks)."""
        return tuple(self.catalogue_.get(installer, {}).get("heatpump_kw") or physics.HP_CATALOGUE_KW)

    # ------------------------------------------------------------------ persistence
    def save(self, path: Path | str = MODEL_PATH):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._last = None
        joblib.dump(self, path)

    @staticmethod
    def load(path: Path | str = MODEL_PATH) -> "DesignModel":
        return joblib.load(path)


def contextualise_pv_flags(flags: list[dict]) -> list[dict]:
    """
    A physics "PV_OVERSIZED" warning is relative to ALL expert systems; small homes legitimately sit above it (experts gave
    homes under 2,000 kWh a median 6 kWp = 3.7x their consumption). When the similar-homes check in the same list says the
    size is typical for THIS consumption (PV_TYPICAL), the warning becomes information. Errors (> p99) are never downgraded.
    """
    typical = next((f for f in flags if f.get("code") == "PV_TYPICAL"), None)
    if typical is None or not any(f.get("code") == "PV_OVERSIZED" for f in flags):
        return flags
    out = []
    for f in flags:
        if f.get("code") == "PV_OVERSIZED" and f.get("level") == "warn":
            f = {**f, "level": "info", "message": f["message"].rstrip(".") +
                 f". Still typical for homes with this consumption at this installer ({typical['message'].rstrip('.')})."}
        out.append(f)
    return out


# ---------------------------------------------------------------------- conversions
def home_to_row(home: dict, installer: str) -> dict:
    """api.md `home` -> the input columns the features expect. offer_date None = today (capped)."""
    # a planner-typed 4,500 kWh is a REAL value unless the caller says it was left at the tool's default
    # (home.demand_is_default: the web sends it; /project takes it from the data)
    flag = home.get("demand_is_default")
    return dict(installer=installer, annual_kwh=home.get("annual_kwh"), demand_is_default=bool(flag) if flag is not None else False,
                price_eur_kwh=home.get("price_eur_kwh"),
                load_profile=home.get("load_profile") or "H0", has_ev=bool(home.get("has_ev")),
                ev_km_year=home.get("ev_km_year"), heating=home.get("heating"),
                heating_demand_kwh=home.get("heating_demand_kwh"),
                existing_pv=_existing_pv(home), existing_battery=bool(home.get("existing_battery_kwh")),
                existing_wallbox=bool(home.get("existing_wallbox")), offer_date=home.get("offer_date"),
                roof_max_kwp=home.get("roof_max_kwp"))


TYPICAL_EXISTING_PV_KWP = 8.0     # assumed size when the planner only says "there is PV already"


def _existing_pv(home: dict):
    """yes / no / unknown: existing_pv_kwp (0 = no) wins over has_existing_pv; neither = unknown (None)."""
    if home.get("existing_pv_kwp") is not None:
        return float(home["existing_pv_kwp"]) > 0
    if home.get("has_existing_pv") is not None:
        return bool(home["has_existing_pv"])
    return None


def home_to_physics(home: dict) -> physics.Home:
    return physics.Home(annual_kwh=home.get("annual_kwh"), load_profile=home.get("load_profile") or "H0",
                        has_ev=bool(home.get("has_ev")), ev_km_year=home.get("ev_km_year"), heating=home.get("heating"),
                        heating_demand_kwh=home.get("heating_demand_kwh"),
                        existing_pv_kwp=home.get("existing_pv_kwp") or
                        (TYPICAL_EXISTING_PV_KWP if home.get("has_existing_pv") else None),
                        price_eur_kwh=home.get("price_eur_kwh"),
                        orientation_deg=_first(home.get("roof_azimuth"), home.get("orientation_deg")),
                        tilt_deg=_first(home.get("roof_pitch"), home.get("tilt_deg")),
                        roof_max_kwp=home.get("roof_max_kwp"))


def _first(*values):
    return next((v for v in values if v is not None), None)


def _fmt(feature: str, value) -> str:
    if value is None or (isinstance(value, float) and np.isnan(value)):
        return "unknown"
    if feature in ("total_demand_kwh", "annual_kwh", "heating_demand_kwh"):
        return f"{value:,.0f} kWh"
    if feature == "pv_kwp_planned":
        return f"{value:.1f} kWp"
    if feature == "price_eur_kwh":
        return f"{value:.2f} EUR/kWh"
    if feature == "ev_km":
        return f"{value:,.0f} km"
    if feature == "offer_month":
        return (pd.Timestamp("2024-01-01") + pd.DateOffset(months=int(value))).strftime("%b %Y")
    if feature == "daytime_presence":
        return {1: "often at home", -1: "away during the day"}.get(int(value), "average")
    return "yes" if value else "no"
