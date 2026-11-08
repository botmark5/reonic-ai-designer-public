"""
engine/physics.py - a simple, explainable energy model for a German single-family home.

What it answers (for /design "physics", /validate flags and the homeowner view):
    * How much does the PV system produce?              pv_specific_yield(), simulate()
    * How much of it does the home use itself?          simulate() -> self_consumption, autarky
    * Which heat pump size fits, and what does it add?  heatpump_size_kw(), heatpump_recommendation()
    * What does the homeowner save, when does it pay?   economics()
    * Is a design physically odd?                       sanity_flags()

Method: an HOURLY SYNTHETIC YEAR (8,760 hours).
    PV:   yearly yield split over months (German climate), a daylight bell curve per day and a seeded
          sunny/cloudy factor per day (each month still sums to its share of the yearly yield).
    Load: a 24-hour shape per household profile (H0 + Reonic presets), winter/summer and weekend factors,
          plus the electric car (evening charging) and a new heat pump (by heating season).
    Battery: charges from PV surplus, discharges when the home needs power (self-consumption first).
All shapes are synthetic approximations, NOT the official BDEW/weather tables. They are calibrated so the
results land in published German rule-of-thumb ranges (see tests/test_physics.py::test_calibration_*).
Everything is deterministic: the same inputs and seed always give the same numbers.
"""
from __future__ import annotations

import tomllib
from dataclasses import asdict, dataclass, field
from functools import lru_cache
from pathlib import Path

import numpy as np

# ---------------------------------------------------------------------------
# Constants (every number here is an assumption; they are listed in docs/data-notes.md)
# ---------------------------------------------------------------------------
HOURS = 8760
DAYS = 365
BASE_YIELD_KWH_PER_KWP = 950.0      # south-facing ~30-35 deg roof in Germany, yearly average
LATITUDE_DEG = 48.0                 # roughly Munich; sets day length
SOLAR_NOON_HOUR = 13.0              # local clock time of the sun's highest point (CET/CEST average)

# Share of the yearly PV yield per month (Germany, typical; normalised below)
PV_MONTH_SHARE = np.array([2.7, 4.6, 8.0, 11.4, 13.2, 13.4, 13.6, 11.8, 8.9, 6.0, 3.2, 2.0])
PV_MONTH_SHARE = PV_MONTH_SHARE / PV_MONTH_SHARE.sum()

# Orientation/tilt factor relative to the best roof (south, ~35 deg). Rows: deviation from south in deg
# (0 = south, 90 = east or west, 180 = north). Columns: tilt in deg. Rule-of-thumb values for Germany.
_AZ_DEV = np.array([0, 45, 90, 135, 180])
_TILT = np.array([0, 15, 30, 45, 60, 90])
_ORIENT_FACTOR = np.array([
    #  0     15    30    45    60    90   tilt
    [0.88, 0.96, 1.00, 0.99, 0.94, 0.70],   # south
    [0.88, 0.94, 0.95, 0.93, 0.87, 0.66],   # south-east / south-west
    [0.88, 0.87, 0.85, 0.81, 0.75, 0.56],   # east / west
    [0.88, 0.80, 0.72, 0.64, 0.56, 0.40],   # north-east / north-west
    [0.88, 0.76, 0.62, 0.51, 0.42, 0.28],   # north
])

# PVGIS (EU JRC) replaces the rule-of-thumb table when engine/config/pvgis_augsburg.json is present:
# real yearly yield per tilt x orientation (central German location), normalised to south / 30 deg = 1.0,
# and the real monthly split of the yearly yield. The base (950 kWh/kWp, German average) stays: Augsburg itself
# yields more (1,120 kWh/kWp at south 30 deg) and the projects' locations are unknown.
PVGIS_FILE = Path(__file__).resolve().parent / "config" / "pvgis_augsburg.json"


def _load_pvgis():
    global _AZ_DEV, _TILT, _ORIENT_FACTOR, PV_MONTH_SHARE, PV_SOURCE
    PV_SOURCE = "rule-of-thumb table"
    if not PVGIS_FILE.exists():
        return
    import json
    d = json.loads(PVGIS_FILE.read_text())
    y = {tuple(int(v) for v in k.split("|")): e for k, e in d["yield_kwh_per_kwp"].items()}
    tilts = sorted({t for t, _ in y})
    devs = [0, 45, 90, 135, 180]
    ref = y[(30, 0)]
    table = []
    for dev in devs:
        row = []
        for t in tilts:
            if t == 0:
                row.append(y[(0, 0)] / ref)
            else:
                vals = [y[(t, a)] for a in ({dev, -dev} if dev not in (0, 180) else {dev}) if (t, a) in y]
                row.append(float(np.mean(vals)) / ref)
        table.append(row)
    _AZ_DEV, _TILT, _ORIENT_FACTOR = np.array(devs), np.array(tilts), np.array(table)
    if d.get("monthly_south_35"):
        m = np.array(d["monthly_south_35"], dtype=float)
        PV_MONTH_SHARE = m / m.sum()
    PV_SOURCE = "PVGIS v5.3 (EU JRC), Augsburg"


_load_pvgis()

# Household load: relative consumption per hour of day (0..23), H0-like weekday shape
H0_SHAPE = np.array([0.60, 0.45, 0.40, 0.38, 0.38, 0.42, 0.60, 0.85, 0.95, 0.95, 0.95, 1.00,
                     1.10, 1.05, 0.95, 0.90, 0.95, 1.10, 1.40, 1.55, 1.50, 1.35, 1.10, 0.80])
_DAY, _MORNING, _EVENING = slice(8, 17), slice(6, 8), slice(17, 23)
# Reonic presets as multipliers on daytime / morning / evening consumption (who is at home when)
PROFILE_MULTIPLIERS = {
    "H0":                       dict(day=1.00, morning=1.00, evening=1.00),
    "HomeOfficeOnePerson":      dict(day=1.35, morning=1.00, evening=1.00),
    "SeniorOnePerson":          dict(day=1.30, morning=1.00, evening=0.95),
    "FullTimeOnePerson":        dict(day=0.60, morning=1.20, evening=1.20),
    "PartTimeOnePerson":        dict(day=0.85, morning=1.10, evening=1.10),
    "FamilyOfFour":             dict(day=0.95, morning=1.20, evening=1.15),
    "SingleParentThreePersons": dict(day=0.90, morning=1.15, evening=1.15),
}
WEEKEND_DAY_FACTOR = 1.20           # people are home more on Sat/Sun
SEASONAL_AMPLITUDE = 0.17           # household load: winter ~ +17 %, summer ~ -17 %

# Variability. Smooth synthetic curves overstate self-consumption (in reality the kettle runs when a cloud
# passes). These values were tuned so results match published German rule-of-thumb ranges
# (HTW Berlin "Unabhaengigkeitsrechner"): 4,500 kWh + 5 kWp ~ 30 % SC / 33 % autarky, +5 kWh battery ~ 55 %,
# 10 kWp + 10 kWh ~ 77 %. See docs/data-notes.md "Physics assumptions".
LOAD_HOURLY_NOISE_SIGMA = 0.9       # lognormal hour-to-hour spread of household consumption
PV_HOURLY_NOISE_SIGMA = 0.4         # lognormal hour-to-hour spread of PV (passing clouds)
CLOUD_BETA = (0.7, 0.9)             # day-to-day sunny/cloudy distribution (Beta a, b): many dull + many bright days
CLOUD_FLOOR = 0.02                  # darkest day still produces 2 % of a clear day

# Electric car
EV_KWH_PER_100KM = 18.0
EV_DEFAULT_KM = 12000               # used when "has EV" but no distance is given
EV_CHARGING_HOURS = {"evening": range(18, 23), "solar": range(10, 15)}

# Heat pump
HP_SCOP = 3.5                       # seasonal coefficient of performance: kWh heat per kWh electricity
HP_FULL_LOAD_HOURS = 2450           # heat demand / heat pump kW; median of the 13 heat-pump projects (installer_a)
HP_CATALOGUE_KW = (5.5, 7.5, 8.0, 10.5, 12.5)   # sizes installer A actually sold (docs/labels-rules.md R4)
HP_HOT_WATER_SHARE = 0.15           # part of heat demand that is hot water (flat over the year)
# Share of space heating per month (heating degree days, Germany)
HEATING_MONTH_SHARE = np.array([17, 15, 13, 8, 4, 1, 0.5, 0.5, 2.5, 7, 12, 16], dtype=float)
HEATING_MONTH_SHARE = HEATING_MONTH_SHARE / HEATING_MONTH_SHARE.sum()
FOSSIL_HEATING = {"Gas", "Oil", "OtherNonRenewable"}

# Plausibility thresholds, CALIBRATED ON THE EXPERTS' OWN NEW-SYSTEM DESIGNS (training part of the locked split,
# 1,046 homes, 8 Nov): PV yield / yearly consumption is above 2 in 44 % of expert designs and above 3 in 13 %
# (p75 = 2.5, p95 = 3.7, p97.5 = 4.4, p99 = 5.4), so the earlier 2x / 3x cut-offs flagged half of what experts sell
# as "check" and 13 % as "implausible". Small homes are sized this way on purpose (feed-in pays): homes under
# 2,000 kWh got a median 6 kWp and a battery in 100 % of cases. Battery kWh per kWp of PV: p95 = 1.7, p99 = 2.2.
PV_RATIO_INFO = 2.5                 # above p75 of expert designs: most of the yield is fed in (information only)
PV_RATIO_WARN = 4.0                 # above ~p96 of expert designs: unusually large for the consumption
PV_RATIO_ERROR = 5.5                # above p99: implausible even for these installers
BATTERY_KWH_PER_KWP_WARN = 2.0      # above ~p98 of expert designs (usual 0.5-1.7)

# Battery
BATTERY_USABLE_SHARE = 0.90         # usable capacity of the nominal kWh
BATTERY_C_RATE = 0.5                # max charge/discharge power = 0.5 x capacity per hour
BATTERY_EFFICIENCY = 0.95           # one-way (charge and discharge each lose 5 %)

ECONOMICS_CONFIG = Path(__file__).resolve().parent / "config" / "economics.toml"

# Calendar of a non-leap year starting on a Wednesday (2025)
_DAY_INDEX = np.arange(DAYS)
_MONTH_OF_DAY = np.repeat(np.arange(12), [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31])
_IS_WEEKEND = ((_DAY_INDEX + 2) % 7) >= 5


# ---------------------------------------------------------------------------
# Inputs and outputs
# ---------------------------------------------------------------------------
@dataclass
class Home:
    """The home before the project. Field names follow docs/api.md ("home")."""
    annual_kwh: float | None                    # household electricity per year (without EV / new heat pump)
    load_profile: str | None = "H0"
    has_ev: bool = False
    ev_km_year: float | None = None
    ev_charging: str = "evening"                # "evening" or "solar"
    heating: str | None = None                  # existing heating: Gas, Oil, Heatpump, ...
    heating_demand_kwh: float | None = None     # yearly heat demand
    existing_heatpump_kwh: float | None = None  # electricity of an EXISTING heat pump, if known separately
    existing_pv_kwp: float | None = None
    price_eur_kwh: float | None = None
    price_increase: float | None = None
    orientation_deg: float | None = None        # compass azimuth: 180 = south, 90 = east, 270 = west
    tilt_deg: float | None = None
    roof_max_kwp: float | None = None           # max PV the roof fits (e.g. Google Solar API)


@dataclass
class System:
    """A proposed design."""
    pv_kwp: float = 0.0
    battery_kwh: float = 0.0
    heatpump_kw: float = 0.0     # NEW heat pump (0 = none)
    wallbox: bool = False


@dataclass
class SimResult:
    yield_kwh: float             # PV production per year
    specific_yield: float        # kWh per kWp
    load_kwh: float              # total consumption: household + EV + heat pumps
    household_kwh: float
    ev_kwh: float
    heatpump_kwh: float          # new + existing heat pump electricity
    self_used_kwh: float         # PV used in the home (directly or via the battery)
    grid_import_kwh: float
    feed_in_kwh: float
    battery_losses_kwh: float    # conversion losses + energy left in the battery at year end
    battery_cycles: float        # full equivalent cycles per year
    self_consumption: float      # share of PV used in the home (0..1)
    autarky: float               # share of consumption covered by PV (0..1)
    assumptions: list[str] = field(default_factory=list)

    def to_dict(self):
        return asdict(self)


def _check_non_negative(**values):
    for name, v in values.items():
        if v is not None and (not np.isfinite(v) or v < 0):
            raise ValueError(f"{name} must be a non-negative number, got {v!r}")


# ---------------------------------------------------------------------------
# 1. PV
# ---------------------------------------------------------------------------
def pv_specific_yield(orientation_deg: float | None = None, tilt_deg: float | None = None,
                      base: float = BASE_YIELD_KWH_PER_KWP) -> tuple[float, list[str]]:
    """Yearly kWh per kWp for a roof orientation/tilt. Missing values -> best case (south, 30 deg) + a note."""
    notes = []
    if orientation_deg is None or (isinstance(orientation_deg, float) and np.isnan(orientation_deg)):
        orientation_deg = 180.0
        notes.append("Roof orientation unknown: assumed south-facing.")
    if tilt_deg is None or (isinstance(tilt_deg, float) and np.isnan(tilt_deg)):
        tilt_deg = 30.0
        notes.append("Roof tilt unknown: assumed 30 degrees.")
    dev = abs(((float(orientation_deg) - 180.0) + 180.0) % 360.0 - 180.0)   # 0..180 deviation from south
    tilt = float(np.clip(tilt_deg, 0, 90))
    # bilinear interpolation in the factor table
    rows = np.array([np.interp(tilt, _TILT, r) for r in _ORIENT_FACTOR])
    factor = float(np.interp(dev, _AZ_DEV, rows))
    return base * factor, notes


def _day_length_hours():
    """Approximate day length per day of year at LATITUDE_DEG (astronomical formula)."""
    decl = np.radians(23.44) * np.sin(2 * np.pi * (284 + _DAY_INDEX + 1) / 365)
    lat = np.radians(LATITUDE_DEG)
    cos_h = np.clip(-np.tan(lat) * np.tan(decl), -1, 1)
    return 2 * np.degrees(np.arccos(cos_h)) / 15.0


@lru_cache(maxsize=64)
def _pv_unit_profile(orientation_deg: float, seed: int) -> np.ndarray:
    """Hourly PV profile for 1 kWh of yearly yield (sums to 1). Cached: it only depends on orientation + seed."""
    rng = np.random.default_rng(seed)
    length = _day_length_hours()
    sunrise = SOLAR_NOON_HOUR - length / 2
    # east-facing roofs produce earlier, west-facing later (up to ~2.5 h shift of the peak)
    az_shift = float(np.clip((orientation_deg - 180.0) / 90.0, -1, 1)) * 2.5
    t = np.arange(24) + 0.5                                       # middle of each hour
    phase = (t[None, :] - sunrise[:, None]) / length[:, None]     # 0..1 during daylight
    bell = np.where((phase > 0) & (phase < 1), np.sin(np.pi * np.clip(phase, 0, 1)), 0.0)
    peak = SOLAR_NOON_HOUR + az_shift
    bell = bell * np.exp(-((t[None, :] - peak) / (0.45 * length[:, None])) ** 2)
    bell = bell * rng.lognormal(0.0, PV_HOURLY_NOISE_SIGMA, bell.shape)   # passing clouds
    bell = bell / bell.sum(axis=1, keepdims=True)                 # each day sums to 1
    # weather: sunny/cloudy factor per day (Beta distribution, seeded), longer days produce more
    cloud = CLOUD_FLOOR + (1 - CLOUD_FLOOR) * rng.beta(*CLOUD_BETA, size=DAYS)
    day_energy = cloud * length
    # renormalise so every month keeps its share of the yearly yield
    for m in range(12):
        mask = _MONTH_OF_DAY == m
        day_energy[mask] *= PV_MONTH_SHARE[m] / day_energy[mask].sum()
    return (bell * day_energy[:, None]).ravel()


# ---------------------------------------------------------------------------
# 2. Loads
# ---------------------------------------------------------------------------
def _profile_shape(load_profile: str | None) -> tuple[np.ndarray, list[str]]:
    notes = []
    if load_profile not in PROFILE_MULTIPLIERS:
        notes.append(f"Load profile {load_profile!r} has no preset: used the standard household profile H0.")
        load_profile = "H0"
    mult = PROFILE_MULTIPLIERS[load_profile]
    shape = H0_SHAPE.copy()
    shape[_DAY] *= mult["day"]
    shape[_MORNING] *= mult["morning"]
    shape[_EVENING] *= mult["evening"]
    return shape, notes


@lru_cache(maxsize=32)
def _household_unit_profile(load_profile: str, seed: int = 42) -> np.ndarray:
    """Hourly household load for 1 kWh per year (sums to 1), with seeded hour-to-hour noise."""
    shape, _ = _profile_shape(load_profile)
    days = np.tile(shape, (DAYS, 1))
    weekend = days[_IS_WEEKEND]
    weekend[:, _DAY] *= WEEKEND_DAY_FACTOR
    days[_IS_WEEKEND] = weekend
    season = 1 + SEASONAL_AMPLITUDE * np.cos(2 * np.pi * (_DAY_INDEX - 15) / 365)   # peak mid-January
    days = days / days.sum(axis=1, keepdims=True) * season[:, None]
    # appliances switch on and off: spread each hour (seeded, offset so it is independent of the PV noise)
    days = days * np.random.default_rng(seed + 1000).lognormal(0.0, LOAD_HOURLY_NOISE_SIGMA, days.shape)
    return (days / days.sum()).ravel()


def ev_kwh(has_ev: bool, ev_km_year: float | None) -> tuple[float, list[str]]:
    """Yearly EV electricity: km / 100 x 18 kWh."""
    if not has_ev:
        return 0.0, []
    if ev_km_year is None or (isinstance(ev_km_year, float) and np.isnan(ev_km_year)):
        return EV_DEFAULT_KM / 100 * EV_KWH_PER_100KM, [f"EV distance unknown: assumed {EV_DEFAULT_KM:,} km/year."]
    return float(ev_km_year) / 100 * EV_KWH_PER_100KM, []


def _ev_unit_profile(charging: str) -> np.ndarray:
    hours = EV_CHARGING_HOURS.get(charging, EV_CHARGING_HOURS["evening"])
    day = np.zeros(24)
    day[list(hours)] = 1.0
    return np.tile(day / day.sum() / DAYS, DAYS)


@lru_cache(maxsize=1)
def _heating_unit_profile() -> np.ndarray:
    """Hourly heat-pump electricity for 1 kWh per year: space heating by month + flat hot water."""
    per_day = np.zeros(DAYS)
    for m in range(12):
        mask = _MONTH_OF_DAY == m
        per_day[mask] = HEATING_MONTH_SHARE[m] / mask.sum()
    per_day = (1 - HP_HOT_WATER_SHARE) * per_day + HP_HOT_WATER_SHARE / DAYS
    return np.repeat(per_day / 24, 24)


# ---------------------------------------------------------------------------
# 3. Heat pump rule (too few heat-pump projects in the data to learn it)
# ---------------------------------------------------------------------------
def heatpump_size_kw(heating_demand_kwh: float | None, catalogue=HP_CATALOGUE_KW,
                     full_load_hours: float = HP_FULL_LOAD_HOURS) -> tuple[float | None, str]:
    """Heat pump kW = yearly heat demand / full-load hours, snapped to the nearest catalogue size."""
    if heating_demand_kwh is None or (isinstance(heating_demand_kwh, float) and np.isnan(heating_demand_kwh)):
        return None, "Heating demand unknown: heat pump size cannot be calculated (ask for the yearly gas/oil use)."
    _check_non_negative(heating_demand_kwh=heating_demand_kwh)
    if heating_demand_kwh == 0:
        return None, "Heating demand is 0 kWh: no heat pump needed."
    raw = heating_demand_kwh / full_load_hours
    kw = float(min(catalogue, key=lambda c: abs(c - raw)))
    note = (f"{heating_demand_kwh:,.0f} kWh heat / {full_load_hours:,.0f} full-load hours = {raw:.1f} kW "
            f"-> catalogue size {kw:g} kW.")
    if raw > max(catalogue) * 1.25:
        note += " Demand exceeds the largest catalogue size: check insulation or a cascade."
    return kw, note


def heatpump_extra_kwh(heating_demand_kwh: float | None, scop: float = HP_SCOP) -> float:
    """Extra electricity a new heat pump needs: heat demand / SCOP."""
    if not heating_demand_kwh or np.isnan(heating_demand_kwh):
        return 0.0
    return float(heating_demand_kwh) / scop


def heatpump_recommendation(heating: str | None, heating_demand_kwh: float | None,
                            installer_sells_heatpumps: bool = True, catalogue=HP_CATALOGUE_KW) -> dict:
    """Rule: gas/oil heating -> heat pump candidate; never when a heat pump already exists."""
    if not installer_sells_heatpumps:
        return dict(include=False, kw=None, reasons=["This installer does not offer heat pumps."])
    if heating == "Heatpump":
        return dict(include=False, kw=None, reasons=["The home already heats with a heat pump."])
    if heating not in FOSSIL_HEATING:
        return dict(include=False, kw=None,
                    reasons=["No gas/oil heating recorded: installers almost never add a heat pump then."])
    kw, note = heatpump_size_kw(heating_demand_kwh, catalogue)
    return dict(include=kw is not None or heating_demand_kwh is None, kw=kw,
                reasons=[f"The home heats with {heating}: a heat pump is a candidate.", note])


# ---------------------------------------------------------------------------
# 4. Hourly simulation
# ---------------------------------------------------------------------------
def _dispatch(pv: np.ndarray, load: np.ndarray, battery_kwh: float):
    """Greedy self-consumption battery. Returns (direct, charged, discharged, feed_in, grid_import)."""
    direct = np.minimum(pv, load)
    surplus = pv - direct
    deficit = load - direct
    if battery_kwh <= 0:
        return direct.sum(), 0.0, 0.0, surplus.sum(), deficit.sum()
    cap = battery_kwh * BATTERY_USABLE_SHARE
    p_max = battery_kwh * BATTERY_C_RATE
    eff = BATTERY_EFFICIENCY
    soc = 0.0
    charged = discharged = feed = imp = 0.0
    for s, d in zip(surplus.tolist(), deficit.tolist()):
        if s > 0:
            c = min(s, p_max, (cap - soc) / eff)
            soc += c * eff
            charged += c
            feed += s - c
        elif d > 0:
            out = min(d, p_max, soc * eff)
            soc -= out / eff
            discharged += out
            imp += d - out
    return direct.sum(), charged, discharged, feed, imp


def simulate(home: Home, system: System, seed: int = 42) -> SimResult:
    """Simulate one year hour by hour. Raises ValueError for missing demand or negative numbers."""
    if home.annual_kwh is None or (isinstance(home.annual_kwh, float) and np.isnan(home.annual_kwh)):
        raise ValueError("annual_kwh is required (yearly household electricity demand).")
    _check_non_negative(annual_kwh=home.annual_kwh, ev_km_year=home.ev_km_year, pv_kwp=system.pv_kwp,
                        battery_kwh=system.battery_kwh, heatpump_kw=system.heatpump_kw,
                        heating_demand_kwh=home.heating_demand_kwh, existing_pv_kwp=home.existing_pv_kwp,
                        existing_heatpump_kwh=home.existing_heatpump_kwh)
    notes: list[str] = []

    # --- consumption -------------------------------------------------------
    _, prof_notes = _profile_shape(home.load_profile)
    notes += prof_notes
    profile = home.load_profile if home.load_profile in PROFILE_MULTIPLIERS else "H0"
    household = float(home.annual_kwh)
    ev, ev_notes = ev_kwh(home.has_ev, home.ev_km_year)
    notes += ev_notes
    hp_new = 0.0
    if system.heatpump_kw > 0:
        demand = home.heating_demand_kwh
        if not demand:
            demand = system.heatpump_kw * HP_FULL_LOAD_HOURS
            notes.append(f"Heating demand unknown: estimated {demand:,.0f} kWh from the heat pump size.")
        hp_new = heatpump_extra_kwh(demand)
    hp_existing = float(home.existing_heatpump_kwh or 0.0)
    load = (household * _household_unit_profile(profile, seed) + ev * _ev_unit_profile(home.ev_charging)
            + (hp_new + hp_existing) * _heating_unit_profile())

    # --- production (new PV + existing PV both feed the home) ---------------
    specific, yield_notes = pv_specific_yield(home.orientation_deg, home.tilt_deg)
    total_kwp = float(system.pv_kwp) + float(home.existing_pv_kwp or 0.0)
    if total_kwp > 0:
        notes += yield_notes
    orient = 180.0 if home.orientation_deg is None else float(home.orientation_deg)
    pv = total_kwp * specific * _pv_unit_profile(orient, seed)

    direct, charged, discharged, feed, imp = _dispatch(pv, load, float(system.battery_kwh))
    pv_total, load_total = float(pv.sum()), float(load.sum())
    self_used = direct + discharged
    return SimResult(
        yield_kwh=pv_total, specific_yield=specific, load_kwh=load_total, household_kwh=household,
        ev_kwh=ev, heatpump_kwh=hp_new + hp_existing, self_used_kwh=self_used,
        grid_import_kwh=imp, feed_in_kwh=feed, battery_losses_kwh=charged - discharged,
        battery_cycles=(discharged / system.battery_kwh) if system.battery_kwh > 0 else 0.0,
        self_consumption=self_used / pv_total if pv_total > 0 else 0.0,   # PV actually used in the home
        autarky=self_used / load_total if load_total > 0 else 0.0,
        assumptions=notes)


# ---------------------------------------------------------------------------
# 5. Homeowner economics (all prices from engine/config/economics.toml, placeholders!)
# ---------------------------------------------------------------------------
def load_economics_config(path: Path | str = ECONOMICS_CONFIG) -> dict:
    with open(path, "rb") as f:
        return tomllib.load(f)


def economics(home: Home, system: System, sim: SimResult | None = None, config: dict | None = None) -> dict:
    """
    Savings and payback for the homeowner. Baseline = the same consumption bought entirely from the grid.
    Returns capex, first-year savings (electricity + heat pump), payback years (None if not within lifetime).
    """
    cfg = config or load_economics_config()
    sim = sim or simulate(home, system)
    notes = ["All prices are placeholder market assumptions (engine/config/economics.toml)."]
    el, gen = cfg["electricity"], cfg["general"]
    price = home.price_eur_kwh if home.price_eur_kwh else el["default_price_eur_kwh"]
    if not home.price_eur_kwh:
        notes.append(f"Electricity price unknown: assumed {price:.2f} EUR/kWh.")
    increase = home.price_increase if home.price_increase is not None else el["price_increase_per_year"]

    # --- investment ----------------------------------------------------------
    capex = {
        "pv": cfg["pv"]["capex_fixed_eur"] + cfg["pv"]["capex_per_kwp_eur"] * system.pv_kwp if system.pv_kwp > 0 else 0.0,
        "battery": cfg["battery"]["capex_fixed_eur"] + cfg["battery"]["capex_per_kwh_eur"] * system.battery_kwh
        if system.battery_kwh > 0 else 0.0,
        "wallbox": cfg["wallbox"]["capex_eur"] if system.wallbox else 0.0,
        "heatpump": (cfg["heatpump"]["capex_fixed_eur"] + cfg["heatpump"]["capex_per_kw_eur"] * system.heatpump_kw)
        * (1 - cfg["heatpump"]["subsidy_share"]) if system.heatpump_kw > 0 else 0.0,
    }
    capex_total = float(sum(capex.values()))

    # --- yearly savings (year 1) -------------------------------------------------
    # electricity: every kWh the PV covers is not bought; surplus earns the feed-in tariff
    avoided_import_eur = price * sim.self_used_kwh
    feed_in_eur = el["feed_in_tariff_eur_kwh"] * sim.feed_in_kwh
    # heat pump: no more gas/oil; its electricity is part of the load above, so subtract it at grid price
    heat_eur = 0.0
    if system.heatpump_kw > 0:
        heat_demand = home.heating_demand_kwh or system.heatpump_kw * HP_FULL_LOAD_HOURS
        fuel = cfg["fuel"]
        fuel_price = {"Gas": fuel["gas_eur_kwh"], "Oil": fuel["oil_eur_kwh"]}.get(home.heating, fuel["other_eur_kwh"])
        hp_elec = heatpump_extra_kwh(heat_demand)
        heat_eur = heat_demand / fuel["boiler_efficiency"] * fuel_price - hp_elec * price
    first_year = avoided_import_eur + feed_in_eur + heat_eur

    # --- payback with price increase and module degradation -----------------
    degr = cfg["pv"]["degradation_per_year"]
    cumulative, payback = 0.0, None
    for year in range(1, gen["lifetime_years"] + 1):
        grow, age = (1 + increase) ** (year - 1), (1 - degr) ** (year - 1)
        saving = avoided_import_eur * grow * age + feed_in_eur * age + heat_eur * grow
        if payback is None and saving > 0 and cumulative + saving >= capex_total:
            payback = year - 1 + (capex_total - cumulative) / saving
        cumulative += saving
    if capex_total == 0:
        payback = 0.0
    return dict(capex_eur=capex, capex_total_eur=capex_total, price_eur_kwh=price,
                savings_first_year_eur=first_year, savings_breakdown_eur=dict(
                    avoided_grid_purchase=avoided_import_eur, feed_in=feed_in_eur, heating=heat_eur),
                payback_years=payback, savings_lifetime_eur=cumulative,
                net_benefit_lifetime_eur=cumulative - capex_total, lifetime_years=gen["lifetime_years"],
                assumptions=notes)


# ---------------------------------------------------------------------------
# 6. Sanity flags (same shape as /validate flags: component, level, code, message)
# ---------------------------------------------------------------------------
def _flag(component, level, code, message):
    return dict(component=component, level=level, code=code, message=message)


def sanity_flags(home: Home, system: System, sim: SimResult | None = None, hp_catalogue=HP_CATALOGUE_KW) -> list[dict]:
    """Physical plausibility checks. level: info | warn | error. Never raises for odd inputs.
    hp_catalogue: the installer's heat pump sizes (the same list the design used), for the size check."""
    flags = []
    if home.annual_kwh is None or (isinstance(home.annual_kwh, float) and np.isnan(home.annual_kwh)):
        return [_flag("home", "error", "DEMAND_MISSING", "Yearly electricity demand is missing: cannot size the system.")]
    if home.annual_kwh < 0 or system.pv_kwp < 0 or system.battery_kwh < 0 or system.heatpump_kw < 0:
        return [_flag("home", "error", "NEGATIVE_INPUT", "Negative values are not possible.")]
    if home.annual_kwh == 0:
        flags.append(_flag("home", "error", "DEMAND_ZERO", "Yearly electricity demand is 0 kWh: please check the input."))
    sim = sim or simulate(home, system)

    # PV
    if system.pv_kwp > 0 and sim.load_kwh > 0:
        ratio = system.pv_kwp * sim.specific_yield / sim.load_kwh
        if ratio > PV_RATIO_ERROR:
            flags.append(_flag("pv", "error", "PV_VERY_OVERSIZED",
                               f"PV produces {ratio:.1f}x the home's consumption, more than 99 % of the systems the "
                               "installers' experts sold: most of it will be fed into the grid."))
        elif ratio > PV_RATIO_WARN:
            flags.append(_flag("pv", "warn", "PV_OVERSIZED",
                               f"PV produces {ratio:.1f}x the home's consumption, more than about 95 % of the systems the "
                               "installers' experts sold: a large share goes to the grid."))
        elif ratio > PV_RATIO_INFO:
            flags.append(_flag("pv", "info", "PV_MOSTLY_FED_IN",
                               f"PV produces {ratio:.1f}x the home's consumption: most of the yield is fed into the grid "
                               "at the feed-in tariff. Experts size 1 in 4 new systems this way, small homes most of all."))
    if home.roof_max_kwp and system.pv_kwp > home.roof_max_kwp + 1e-6:
        flags.append(_flag("pv", "warn", "ROOF_CAPACITY_EXCEEDED",
                           f"{system.pv_kwp:g} kWp is more than the roof fits ({home.roof_max_kwp:g} kWp)."))
    if system.pv_kwp > 30:
        flags.append(_flag("pv", "info", "PV_VERY_LARGE", f"{system.pv_kwp:g} kWp is very large for a single-family home."))
    if 0 < system.pv_kwp < 2:
        flags.append(_flag("pv", "info", "PV_TINY", f"{system.pv_kwp:g} kWp is very small (an extension or balcony system?)."))

    # Battery
    has_any_pv = system.pv_kwp > 0 or (home.existing_pv_kwp or 0) > 0
    if system.battery_kwh > 0 and not has_any_pv:
        flags.append(_flag("battery", "warn", "BATTERY_WITHOUT_PV",
                           "Battery without any PV: only useful as an add-on to an existing PV system."))
    total_kwp = system.pv_kwp + (home.existing_pv_kwp or 0)
    if system.battery_kwh > 0 and total_kwp > 0 and system.battery_kwh > BATTERY_KWH_PER_KWP_WARN * total_kwp:
        flags.append(_flag("battery", "warn", "BATTERY_TOO_BIG_FOR_PV",
                           f"Battery {system.battery_kwh:g} kWh is large for {total_kwp:g} kWp of PV "
                           f"({system.battery_kwh / total_kwp:.1f} kWh per kWp; 95 % of expert systems are within 0.5-1.7)."))
    if system.battery_kwh > 0 and sim.load_kwh > 0:
        daily = sim.load_kwh / DAYS
        if system.battery_kwh * BATTERY_USABLE_SHARE > 1.5 * daily:
            flags.append(_flag("battery", "info", "BATTERY_EXCEEDS_DAILY_USE",
                               f"Battery stores more than 1.5 days of consumption ({daily:.1f} kWh/day): "
                               "it will rarely be emptied."))

    # Wallbox / EV
    if system.wallbox and not home.has_ev:
        flags.append(_flag("wallbox", "info", "WALLBOX_WITHOUT_EV", "Wallbox planned but no electric car recorded."))
    if home.has_ev and not system.wallbox:
        flags.append(_flag("wallbox", "info", "EV_WITHOUT_WALLBOX", "The household has an EV but no wallbox is planned."))

    # Heat pump
    if system.heatpump_kw > 0:
        if home.heating == "Heatpump":
            flags.append(_flag("heatpump", "warn", "HEATPUMP_EXISTING", "A new heat pump is planned, but the home already has one."))
        rule_kw, _ = heatpump_size_kw(home.heating_demand_kwh, hp_catalogue or HP_CATALOGUE_KW)
        if rule_kw is None:
            flags.append(_flag("heatpump", "info", "HEATPUMP_DEMAND_UNKNOWN",
                               "Heat pump planned but heating demand unknown: size cannot be checked."))
        elif abs(system.heatpump_kw - rule_kw) / rule_kw > 0.4:
            flags.append(_flag("heatpump", "warn", "HEATPUMP_SIZE_MISMATCH",
                               f"Heat pump {system.heatpump_kw:g} kW differs strongly from the "
                               f"{rule_kw:g} kW the heating demand suggests."))
    return flags
