"""PV size (R1), roof type (R6) and scaffolding (R7) from the line items of one offer option.

Spec: docs/labels-rules.md. Each function is pure over a DataFrame shaped like `items.make_items` output.
"""
import math
import re

import pandas as pd

INSTALLER_B = "installer_b"
INSTALLER_A = "installer_a"

PANEL_WP_ASSUMED = 450.0
_PANEL_KWP = PANEL_WP_ASSUMED / 1000
TOLERANCE_KWP = 0.01
# B: a handful of module lines next to a package are extra panels; many are a redesign of the package.
MAX_EXTRA_MODULE_LINES = 3

_NUMBER = r"(\d+(?:\.\d+)?)"
PACKAGE_B = re.compile(rf"^Complete Package\b.*?{_NUMBER}\s*kWp", re.I)
_PACKAGE_A = re.compile(rf"^PV Complete Package\s+{_NUMBER}\s*kW\b", re.I)
SIZE_BAND = re.compile(rf"^(?:SL Rack )?Substructure\b.*?{_NUMBER}\s*-\s*{_NUMBER}\s*kWp", re.I)
SUBSTRUCTURE = re.compile(r"^(?:SL Rack )?Substructure\b", re.I)
# Panel counts skip the B "Substructure Flat Roof Ballast" kit line (16 lines, always qty 1); roof type still uses it.
PANEL_SUBSTRUCTURE = re.compile(r"^(?:SL Rack )?Substructure\b(?!.*Ballast)", re.I)
DC_INSTALL = re.compile(r"^DC Install\b", re.I)
_ROOF_MOUNTING = re.compile(r"^Roof Mounting\b(?!.*Surcharge)", re.I)
_ROOF_SURCHARGE = re.compile(r"^Roof Mounting\b.*Surcharge", re.I)
# Named extras carry their count in the name ("3x Extra PV Module 480W", "4 Additional Modules (...)").
_EXTRA_BY_NAME = re.compile(r"^(?:(\d+)\s*x\s+(?:Extra\s+)?PV Module|(\d+)\s+Additional Modules?)\b", re.I)
_EXTRA_BY_QTY = re.compile(r"^Additional Module incl\b", re.I)
_NAME_WATT = re.compile(r"(\d{3,4})\s*W\b")

_SCAFFOLD = re.compile(r"Scaffold|^Site Setup / Safety", re.I)

# Order matters: the first pattern that matches names the roof cover.
_ROOF_TYPES = [
    (re.compile(r"Cross-Lay", re.I), "Unknown"),
    (re.compile(r"Facade", re.I), "Facade"),
    (re.compile(r"Beaver Tail", re.I), "Beaver Tail Tile"),
    (re.compile(r"Slate", re.I), "Slate"),
    (re.compile(r"Bitumen", re.I), "Bitumen"),
    (re.compile(r"Flat|Green Roof|Ballast", re.I), "Flat"),
    (re.compile(r"Metal|Standing Seam|Trapezoidal", re.I), "Metal"),
    (re.compile(r"Clay|Mortared", re.I), "Clay Tile"),
    (re.compile(r"Concrete", re.I), "Concrete Tile"),
]
_ROOF_LINES = {"sub": SUBSTRUCTURE, "dc": DC_INSTALL, "surcharge": _ROOF_SURCHARGE}


def _qty(items: pd.DataFrame, mask: pd.Series) -> float:
    return float(items.loc[mask, "quantity"].fillna(1.0).sum())


def _first_number(names: pd.Series, pattern: re.Pattern) -> float | None:
    for name in names:
        match = pattern.search(name)
        if match:
            return float(match.group(1))
    return None


def _named_extras(items: pd.DataFrame) -> list[tuple[float, float]]:
    """(count, watt per panel) per named extra line; watt is 450 when the name has none."""
    extras = []
    for name, qty in zip(items["component_name"], items["quantity"].fillna(1.0)):
        by_name = _EXTRA_BY_NAME.match(name)
        if by_name:
            count = float(by_name.group(1) or by_name.group(2)) * qty
        elif _EXTRA_BY_QTY.match(name):
            count = qty
        else:
            continue
        watt = _NAME_WATT.search(name)
        extras.append((count, float(watt.group(1)) if watt else PANEL_WP_ASSUMED))
    return extras


def _band_midpoint(names: pd.Series) -> float | None:
    for name in names:
        match = SIZE_BAND.match(name)
        if match:
            return (float(match.group(1)) + float(match.group(2))) / 2
    return None


def _panels_in(kwp: float) -> int:
    return round(kwp / _PANEL_KWP)


def extract_pv(items: pd.DataFrame, installer: str) -> dict:
    """R1. Returns pv_kwp, pv_panels (NaN if unknown), pv_source, pv_wp_assumed, pv_sources_disagree."""
    if installer not in (INSTALLER_B, INSTALLER_A):
        raise ValueError(f"unknown installer {installer!r}")
    is_b = installer == INSTALLER_B
    names = items["component_name"]

    modules = items[(items["component_type"] == "Module") & (items["module_watt_peak"] > 0)]
    module_panels = float(modules["quantity"].fillna(1.0).sum())
    module_kwp = float((modules["quantity"].fillna(1.0) * modules["module_watt_peak"]).sum()) / 1000
    module_wp = module_kwp * 1000 / module_panels if module_panels else PANEL_WP_ASSUMED

    substructure = _qty(items, names.str.match(PANEL_SUBSTRUCTURE))
    dc_install = _qty(items, names.str.match(DC_INSTALL))
    roof_mounting = _qty(items, names.str.match(_ROOF_MOUNTING))

    extras = _named_extras(items)
    extra_count = sum(count for count, _ in extras)
    package_pattern = PACKAGE_B if is_b else _PACKAGE_A
    package_kwp = _first_number(names, package_pattern)
    if is_b and package_kwp is not None:
        package_panels = _panels_in(package_kwp) + extra_count
        package_total = package_kwp + sum(count * watt for count, watt in extras) / 1000
    else:
        package_panels, package_total = math.nan, package_kwp

    wp_assumed = math.nan
    if len(modules):
        source = "module_lines"
        kwp, panels = module_kwp, module_panels
        if is_b and package_kwp is not None:
            base_panels = _panels_in(package_kwp)
            if module_panels < base_panels / 2 and module_panels <= MAX_EXTRA_MODULE_LINES:
                kwp, panels = kwp + package_kwp, panels + base_panels
            elif module_panels == base_panels and extra_count:
                kwp, panels = kwp + extra_count * module_wp / 1000, panels + extra_count
    elif is_b and package_kwp is not None:
        source, kwp, panels = "package_name", package_total, package_panels
    elif is_b and roof_mounting >= 2:
        source, kwp, panels, wp_assumed = "roof_mounting", roof_mounting * _PANEL_KWP, roof_mounting, PANEL_WP_ASSUMED
    elif is_b and substructure >= 2:
        source, kwp, panels, wp_assumed = "substructure", substructure * _PANEL_KWP, substructure, PANEL_WP_ASSUMED
    elif is_b and (band := _band_midpoint(names)) is not None:
        source, kwp, panels = "size_band", band, math.nan
    elif not is_b and substructure > 1:
        source, kwp, panels, wp_assumed = "substructure", substructure * _PANEL_KWP, substructure, PANEL_WP_ASSUMED
    elif not is_b and dc_install > 1:
        source, kwp, panels, wp_assumed = "substructure", dc_install * _PANEL_KWP, dc_install, PANEL_WP_ASSUMED
    elif not is_b and package_kwp is not None:
        source, kwp, panels = "package_name", package_kwp, math.nan
    else:
        source, kwp, panels = "none", 0.0, math.nan

    # Per-panel counts of 1 are kits at B; at A every count is a real count (R1 #2, #3).
    min_count = 2 if is_b else 1
    per_panel_wp = module_wp if len(modules) else PANEL_WP_ASSUMED
    others = [package_total] if package_total is not None else []
    counts = (roof_mounting, substructure) if is_b else (substructure, dc_install)
    others += [count * per_panel_wp / 1000 for count in counts if count >= min_count]
    disagree = any(abs(other - kwp) > TOLERANCE_KWP for other in others)

    return {
        "pv_kwp": round(kwp, 6),
        "pv_panels": panels,
        "pv_source": source,
        "pv_wp_assumed": wp_assumed,
        "pv_sources_disagree": disagree,
    }


def _roof_cover(name: str) -> str:
    return next((roof for pattern, roof in _ROOF_TYPES if pattern.search(name)), "Unknown")


def extract_roof_type(items: pd.DataFrame) -> dict:
    """R6. The type with the most panels; roof_mixed when more than one roof cover is named."""
    panels: dict[str, dict[str, float]] = {}
    for name, qty in zip(items["component_name"], items["quantity"].fillna(1.0)):
        for kind, pattern in _ROOF_LINES.items():
            if pattern.match(name):
                roof = _roof_cover(name)
                if roof != "Unknown":
                    by_kind = panels.setdefault(roof, {})
                    by_kind[kind] = by_kind.get(kind, 0.0) + qty
                break
    if not panels:
        return {"roof_type": "Unknown", "roof_mixed": False}
    # substructure and DC install describe the same panels, so take the larger per type instead of adding
    totals = {roof: max(by_kind.values()) for roof, by_kind in panels.items()}
    winner = min(totals, key=lambda roof: (-totals[roof], roof))
    return {"roof_type": winner, "roof_mixed": len(totals) > 1}


def has_scaffolding(items: pd.DataFrame) -> bool:
    """R7. Any 'Scaffold…' line (incl. provided by customer) or the B 'Site Setup / Safety' line."""
    return bool(items["component_name"].str.contains(_SCAFFOLD).any())
