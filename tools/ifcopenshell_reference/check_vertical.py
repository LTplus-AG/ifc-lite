#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Independent check of ifc-lite's IfcAlignmentVertical output against IfcOpenShell.

The vertical counterpart of `check_alignment.py` (mapping spec §12.7). Three
checks, none of which is ifc-lite grading its own arithmetic:

1. MAPPING PARITY. For every IfcAlignmentSegment of each IfcAlignmentVertical,
   IfcOpenShell regenerates the IfcCurveSegment from OUR
   IfcAlignmentVerticalSegment through its own
   `_map_alignment_vertical_segment`, and the result must equal the curve
   segment we wrote in the IfcGradientCurve: placement, direction,
   SegmentStart, SegmentLength, parent curve type and its parameters.
2. TRANSITIONS. IfcOpenShell's `get_curve_segment_transition_code` must agree
   with the Transition we wrote between every pair of curve segments.
3. EVALUATION. IfcOpenShell's kernel evaluates our IfcGradientCurve at every
   station the fixture lists — each PVI, and each vertical curve's ends and
   quarter points — and the height must equal the one the fixture generator
   computed from the LandXML definition of the profile (not from our IFC).

Structure is checked too: the gradient curve is the 'Axis'/'Curve3D'
representation, its BaseCurve is the 'FootPrint'/'Curve2D' composite curve,
and the vertical layout ends in a zero-length CONSTANTGRADIENT segment.

REFUSES TO PASS VACUOUSLY: no vertical layout found, an authored profile
missing from the file, or a vertical layout the fixture does not describe all
fail.

Usage:
    python3 check_vertical.py <file.ifc> <alignment_fixture.json>

The fixture's `authoredVertical` is {"<alignment name>": {"staStart": s,
"heights": [[station, height], ...]}}, in metres. `station` is the INTERNAL
(continuous) station, `staStart` + distance along, so it stays a distance even
on an alignment with station equations, whose profile the generator authors
in displayed stations (mapping spec §14.5).
"""

from __future__ import annotations

import json
import math
import sys

HEIGHT_TOLERANCE = 1e-6  # metres; the fixture heights are exact to the definition
RELATIVE_TOLERANCE = 1e-9


def _close(a: float, b: float) -> bool:
    return math.isclose(a, b, rel_tol=RELATIVE_TOLERANCE, abs_tol=1e-9)


def _norm(v):
    length = math.hypot(v[0], v[1])
    return (v[0] / length, v[1] / length)


def _measure(value) -> float:
    return float(value.wrappedValue if hasattr(value, "wrappedValue") else value)


def _parent_parameters(curve) -> tuple[str, list[float]]:
    kind = curve.is_a()
    if kind == "IfcLine":
        return kind, [*curve.Pnt.Coordinates, *_norm(curve.Dir.Orientation.DirectionRatios), float(curve.Dir.Magnitude)]
    if kind == "IfcCircle":
        return kind, [*curve.Position.Location.Coordinates, float(curve.Radius)]
    if kind == "IfcPolynomialCurve":
        return kind, [*curve.Position.Location.Coordinates, *(curve.CoefficientsX or ()), *(curve.CoefficientsY or ())]
    return kind, []


def _compare_segment(ours, theirs, label: str, problems: list[str]) -> None:
    op, tp = ours.Placement, theirs.Placement
    if not all(_close(a, b) for a, b in zip(op.Location.Coordinates, tp.Location.Coordinates)):
        problems.append(f"{label}: placement location {op.Location.Coordinates} != IfcOpenShell {tp.Location.Coordinates}")
    od, td = _norm(op.RefDirection.DirectionRatios), _norm(tp.RefDirection.DirectionRatios)
    if not (_close(od[0], td[0]) and _close(od[1], td[1])):
        problems.append(f"{label}: placement direction {od} != IfcOpenShell {td}")
    for attribute in ("SegmentStart", "SegmentLength"):
        a, b = _measure(getattr(ours, attribute)), _measure(getattr(theirs, attribute))
        if not _close(a, b):
            problems.append(f"{label}: {attribute} {a} != IfcOpenShell {b}")
    ok, oparams = _parent_parameters(ours.ParentCurve)
    tk, tparams = _parent_parameters(theirs.ParentCurve)
    if ok != tk:
        problems.append(f"{label}: parent curve {ok} != IfcOpenShell {tk}")
    elif len(oparams) != len(tparams) or not all(_close(a, b) for a, b in zip(oparams, tparams)):
        problems.append(f"{label}: {ok} parameters {oparams} != IfcOpenShell {tparams}")


def _check_radius(design, label: str, problems: list[str]) -> None:
    """RadiusOfCurvature is not an input to the geometry mapping, so check its sign
    convention on its own: IfcOpenShell's `layout_vertical_alignment_by_pi_method`
    writes 1/k with k = (EndGradient - StartGradient) / HorizontalLength, positive
    for a sag; a circular arc's magnitude is the radius its mapping derives."""
    kind = design.PredefinedType
    radius = design.RadiusOfCurvature
    if kind == "CONSTANTGRADIENT":
        if radius is not None:
            problems.append(f"{label}: a constant gradient carries RadiusOfCurvature {radius}")
        return
    g0, g1, length = design.StartGradient, design.EndGradient, design.HorizontalLength
    if kind == "PARABOLICARC":
        expected = length / (g1 - g0)
    else:
        expected = math.copysign(length / abs(math.sin(math.atan(g1)) - math.sin(math.atan(g0))), g1 - g0)
    if radius is None or not math.isclose(radius, expected, rel_tol=1e-9):
        problems.append(f"{label}: RadiusOfCurvature {radius} != {expected} (positive for a sag)")


def _representation(alignment, identifier: str, kind: str):
    for representation in alignment.Representation.Representations:
        if representation.RepresentationIdentifier == identifier and representation.RepresentationType == kind:
            return representation.Items[0]
    return None


def check(path: str, authored: dict) -> tuple[list[str], int]:
    """Problems found, and how many vertical layouts were actually compared."""
    import numpy as np
    import ifcopenshell
    import ifcopenshell.api.alignment as A
    import ifcopenshell.geom
    import ifcopenshell.ifcopenshell_wrapper as W
    from ifcopenshell.api.alignment._map_alignment_vertical_segment import _map_alignment_vertical_segment

    model = ifcopenshell.open(path)
    problems: list[str] = []
    profiled = {a.Name: a for a in model.by_type("IfcAlignment") if A.get_vertical_layout(a) is not None}
    if not profiled:
        return ["no IfcAlignment with an IfcAlignmentVertical in the file — nothing was checked"], 0
    for name in authored:
        if name not in profiled:
            problems.append(f"authored profile of alignment {name!r} is not in the file")

    settings = ifcopenshell.geom.settings()
    checked = 0
    for name, alignment in profiled.items():
        if name not in authored:
            problems.append(f"alignment {name!r} has a vertical layout the fixture does not describe")
            continue
        footprint = _representation(alignment, "FootPrint", "Curve2D")
        gradient = _representation(alignment, "Axis", "Curve3D")
        if footprint is None or gradient is None or not gradient.is_a("IfcGradientCurve"):
            problems.append(f"{name}: expected 'FootPrint'/'Curve2D' and an IfcGradientCurve 'Axis'/'Curve3D' representation")
            continue
        if gradient.BaseCurve != footprint:
            problems.append(f"{name}: the gradient curve's BaseCurve is not the FootPrint composite curve")
        layout = list(A.get_alignment_segment_nest(A.get_vertical_layout(alignment)).RelatedObjects)
        ours = list(gradient.Segments)
        if len(ours) != len(layout) or len(layout) < 2:
            problems.append(f"{name}: {len(layout)} vertical layout segments / {len(ours)} gradient curve segments")
            continue
        terminator = layout[-1].DesignParameters
        if terminator.PredefinedType != "CONSTANTGRADIENT" or float(terminator.HorizontalLength) != 0.0:
            problems.append(f"{name}: the last vertical segment is not the zero-length CONSTANTGRADIENT terminator")
        checked += 1

        for index, (segment, our_curve) in enumerate(zip(layout, ours)):
            label = f"{name} vertical segment {index + 1} ({segment.DesignParameters.PredefinedType})"
            theirs, _ = _map_alignment_vertical_segment(model, segment)
            _compare_segment(our_curve, theirs, label, problems)
            _check_radius(segment.DesignParameters, label, problems)
        for index, (segment, following) in enumerate(zip(ours, ours[1:])):
            expected = A.get_curve_segment_transition_code(segment, following)
            if segment.Transition != expected:
                problems.append(f"{name} vertical segment {index + 1}: Transition {segment.Transition} != IfcOpenShell {expected}")
        if ours[-1].Transition != "DISCONTINUOUS":
            problems.append(f"{name}: the terminating gradient curve segment is {ours[-1].Transition}, not DISCONTINUOUS")

        fn = W.map_shape(settings, gradient.wrapped_data)
        evaluator = W.function_item_evaluator(settings, fn)
        sta_start = authored[name]["staStart"]
        for station, height in authored[name]["heights"]:
            # The gradient curve is parameterised by horizontal distance along;
            # the last PVI sits on the base curve's end, which the kernel
            # reaches to within its own integration of the horizontal.
            along = min(max(station - sta_start, fn.start()), fn.end())
            z = float(np.array(evaluator.evaluate(along))[2, 3])
            if abs(z - height) > HEIGHT_TOLERANCE:
                problems.append(
                    f"{name}: height at station {station:.3f} is {z:.6f}, the LandXML profile gives {height:.6f} "
                    f"({abs(z - height):.6f} m off)"
                )
    return problems, checked


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(__doc__)
        return 2
    try:
        import ifcopenshell  # noqa: F401
    except ImportError:
        print("check_vertical.py: ifcopenshell is not importable")
        return 3
    with open(argv[2], encoding="utf-8") as handle:
        fixture = json.load(handle)
    authored = fixture.get("authoredVertical", fixture)
    problems, checked = check(argv[1], authored)
    if problems:
        print(f"check_vertical.py: {len(problems)} problem(s). FAIL.")
        for problem in problems:
            print(f"  - {problem}")
        return 1
    print(f"check_vertical.py: {checked} vertical layout(s) checked, 0 problems.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
