#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Independent check of ifc-lite's stationing IfcReferents against IfcOpenShell.

WHY. The start-station referent and the station-equation referents (LandXML
mapping spec §11.1, §14) carry the alignment's stationing. ifc-lite's own
parser cannot evaluate an IFC4X3 alignment curve, so a position read back
through it would be ifc-lite grading itself. Here IfcOpenShell reads them:

1. STRUCTURE. Through IfcOpenShell's alignment API: the alignment's referent
   nest (`get_referent_nest`) holds the start referent, then one referent per
   authored station equation, in order ALONG the alignment; each is
   `IfcReferent/.STATION.`; `get_alignment_start_station` returns the
   authored start station.
2. STATIONING. `Pset_Stationing` (read with `ifcopenshell.util.element.get_pset`)
   carries the authored `Station`, `IncomingStation` and `HasIncreasingStation`
   (absent where the source did not author `staIncrement`).
3. POSITION. Each referent's `IfcLinearPlacement` measures `DistanceAlong` on
   the alignment's own basis curve (`get_basis_curve`). IfcOpenShell's
   geometry kernel evaluates that curve at that distance, the way its
   `add_stationing_referent` does, and the result must land on the point the
   fixture generator integrated for the equation, independently of ifc-lite's
   TypeScript. The referent's `CartesianPosition` must agree with it.

REFUSES TO PASS VACUOUSLY: an authored alignment missing from the file, an
alignment without a referent nest, or a missing referent all fail.

Usage:
    python3 check_referents.py <file.ifc> <alignment_fixture.json>

The fixture's `referents` key: {"<alignment name>": {"startStation": s,
"equations": [{"distanceAlong", "station", "incomingStation",
"hasIncreasingStation", "point": [x, y]}]}}, lengths in the file's unit; the
start referent's point is the alignment's first `authored` boundary.
"""

from __future__ import annotations

import json
import math
import sys

POSITION_TOLERANCE = 1e-3  # metres
VALUE_TOLERANCE = 1e-9


def _measure(value) -> float:
    return float(value.wrappedValue if hasattr(value, "wrappedValue") else value)


def _close(a, b) -> bool:
    return math.isclose(float(a), float(b), rel_tol=VALUE_TOLERANCE, abs_tol=VALUE_TOLERANCE)


def _check_referent(referent, expected, basis_curve, evaluator, unit_scale, label, problems) -> None:
    import ifcopenshell.util.element as E

    if referent.PredefinedType != "STATION":
        problems.append(f"{label}: PredefinedType {referent.PredefinedType}, not STATION")
    pset = E.get_pset(referent, "Pset_Stationing") or {}
    for prop, key in (("Station", "station"), ("IncomingStation", "incomingStation")):
        if key not in expected:
            continue
        if pset.get(prop) is None or not _close(pset[prop], expected[key]):
            problems.append(f"{label}: Pset_Stationing.{prop} {pset.get(prop)} != authored {expected[key]}")
    if "hasIncreasingStation" in expected and pset.get("HasIncreasingStation") != expected["hasIncreasingStation"]:
        problems.append(
            f"{label}: Pset_Stationing.HasIncreasingStation {pset.get('HasIncreasingStation')} "
            f"!= authored {expected['hasIncreasingStation']}"
        )

    placement = referent.ObjectPlacement
    if placement is None or not placement.is_a("IfcLinearPlacement"):
        problems.append(f"{label}: ObjectPlacement is not an IfcLinearPlacement")
        return
    location = placement.RelativePlacement.Location
    if not location.is_a("IfcPointByDistanceExpression") or location.BasisCurve != basis_curve:
        problems.append(f"{label}: placement is not measured along the alignment's basis curve")
        return
    distance = _measure(location.DistanceAlong)
    if not _close(distance, expected["distanceAlong"]):
        problems.append(f"{label}: DistanceAlong {distance} != authored {expected['distanceAlong']}")

    # IfcOpenShell's kernel evaluates OUR curve at OUR distance.
    matrix = evaluator.evaluate(distance * unit_scale)
    x, y = matrix[0][3] / unit_scale, matrix[1][3] / unit_scale
    ex, ey = expected["point"]
    miss = math.hypot(x - ex, y - ey)
    if miss > POSITION_TOLERANCE:
        problems.append(
            f"{label}: evaluated at DistanceAlong ({x:.4f}, {y:.4f}) is {miss:.4f} from the authored ({ex:.4f}, {ey:.4f})"
        )
    cartesian = placement.CartesianPosition
    if cartesian is not None:
        cx, cy = cartesian.Location.Coordinates[0], cartesian.Location.Coordinates[1]
        drift = math.hypot(cx - x, cy - y)
        if drift > POSITION_TOLERANCE:
            problems.append(f"{label}: CartesianPosition ({cx:.4f}, {cy:.4f}) is {drift:.4f} from the evaluated point")
        tx, ty = matrix[0][0], matrix[1][0]
        rx, ry = cartesian.RefDirection.DirectionRatios[0], cartesian.RefDirection.DirectionRatios[1]
        norm = math.hypot(rx, ry)
        if abs(rx / norm - tx) > 1e-6 or abs(ry / norm - ty) > 1e-6:
            problems.append(f"{label}: CartesianPosition RefDirection ({rx}, {ry}) is not the curve tangent ({tx}, {ty})")


def check(path: str, expectations: dict) -> tuple[list[str], int]:
    """Problems found, and how many referents were actually compared."""
    import ifcopenshell
    import ifcopenshell.api.alignment as A
    import ifcopenshell.geom
    import ifcopenshell.ifcopenshell_wrapper as W
    import ifcopenshell.util.unit

    model = ifcopenshell.open(path)
    by_name = {alignment.Name: alignment for alignment in model.by_type("IfcAlignment")}
    unit_scale = ifcopenshell.util.unit.calculate_unit_scale(model)
    settings = ifcopenshell.geom.settings()
    problems: list[str] = []
    checked = 0

    for name, expected in expectations.items():
        alignment = by_name.get(name)
        if alignment is None:
            problems.append(f"authored alignment {name!r} is not in the file")
            continue
        start = A.get_alignment_start_station(model, alignment)
        if not _close(start, expected["startStation"]):
            problems.append(f"{name}: IfcOpenShell reads start station {start}, authored {expected['startStation']}")
        # IfcOpenShell's own lookup; it returns a new, EMPTY nest when the
        # alignment has none, which the count below then fails.
        referents = list(A.get_referent_nest(model, alignment).RelatedObjects)
        wanted = [{"distanceAlong": 0.0, "station": expected["startStation"]}, *expected["equations"]]
        if len(referents) != len(wanted):
            problems.append(f"{name}: {len(referents)} nested referents for {len(wanted)} authored (start + equations)")
            continue
        basis_curve = A.get_basis_curve(alignment)
        evaluator = W.function_item_evaluator(settings, W.map_shape(settings, basis_curve.wrapped_data))
        for index, (referent, want) in enumerate(zip(referents, wanted)):
            label = f"{name} referent {index + 1} ({'start' if index == 0 else f'station equation {index}'})"
            if index == 0:
                # The start referent lands on the alignment's AUTHORED start point.
                want = {**want, "point": expected["startPoint"]}
            _check_referent(referent, want, basis_curve, evaluator, unit_scale, label, problems)
            checked += 1
    return problems, checked


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(__doc__)
        return 2
    try:
        import ifcopenshell  # noqa: F401
    except ImportError:
        print("check_referents.py: ifcopenshell is not importable")
        return 3
    with open(argv[2], encoding="utf-8") as handle:
        fixture = json.load(handle)
    expectations = fixture.get("referents")
    if not expectations:
        print("check_referents.py: the fixture has no 'referents' key — nothing to check. FAIL.")
        return 1
    # The start referent's expected point is the alignment's first authored
    # boundary, from the same generator (`authored`, see check_alignment.py).
    authored = fixture.get("authored", {})
    expectations = {
        name: {**expected, "startPoint": authored[name][0]} for name, expected in expectations.items() if name in authored
    }
    problems, checked = check(argv[1], expectations)
    if problems:
        print(f"check_referents.py: {len(problems)} problem(s). FAIL.")
        for problem in problems:
            print(f"  - {problem}")
        return 1
    print(f"check_referents.py: {checked} referent(s) checked, 0 problems.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
