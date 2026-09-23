#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Independent check of ifc-lite's IfcAlignment output against IfcOpenShell.

WHY. ifc-lite's own parser cannot evaluate an IFC4X3 IfcAlignment at all (its
Rust evaluator handles IFC4x1 alignment curves only), so every in-repo test of
the LandXML->IFC alignment path would be ifc-lite grading its own arithmetic.
This script has IfcOpenShell do the grading, in two independent ways:

1. MAPPING PARITY. For every IfcAlignmentSegment, IfcOpenShell regenerates the
   IfcCurveSegment from OUR IfcAlignmentHorizontalSegment through its own
   `_map_alignment_horizontal_segment`, and the result must equal the
   IfcCurveSegment we wrote: placement, direction, SegmentStart, SegmentLength,
   parent curve type and its defining parameter. This is what proves the
   geometry is the one a consumer derives from the semantics.
2. EVALUATION. IfcOpenShell's geometry kernel evaluates each of our
   IfcCurveSegments at its start and end. Every boundary must land on the point
   the LandXML source AUTHORED (passed in as JSON), not on a point we computed.
   A sign error in a radius or a direction lands elsewhere, and this says where.

REFUSES TO PASS VACUOUSLY: no alignment found, a segment count that does not
match the authored boundaries, or ifcopenshell not importable all fail.

Usage:
    python3 check_alignment.py <file.ifc> <authored.json>

authored.json: {"<alignment name>": [[x0, y0], [x1, y1], ...]} — the authored
boundary points of each alignment, in order (n segments -> n+1 points), in the
file's length unit, as (X, Y) = (easting, northing).
"""

from __future__ import annotations

import json
import math
import sys

POSITION_TOLERANCE = 1e-3  # metres; the authored points are exact to the fixture
RELATIVE_TOLERANCE = 1e-9


def _close(a: float, b: float) -> bool:
    return math.isclose(a, b, rel_tol=RELATIVE_TOLERANCE, abs_tol=1e-9)


def _norm(v):
    length = math.hypot(v[0], v[1])
    return (v[0] / length, v[1] / length)


def _measure(value) -> float:
    return float(value.wrappedValue if hasattr(value, "wrappedValue") else value)


def _parent_parameter(curve):
    kind = curve.is_a()
    if kind == "IfcCircle":
        return kind, float(curve.Radius)
    if kind == "IfcClothoid":
        return kind, float(curve.ClothoidConstant)
    if kind == "IfcLine":
        return kind, float(curve.Dir.Magnitude)
    return kind, None


def _compare_segment(ours, theirs, label: str, problems: list[str]) -> None:
    op, tp = ours.Placement, theirs.Placement
    for axis in range(2):
        if not _close(op.Location.Coordinates[axis], tp.Location.Coordinates[axis]):
            problems.append(f"{label}: placement location {op.Location.Coordinates} != IfcOpenShell {tp.Location.Coordinates}")
            break
    od, td = _norm(op.RefDirection.DirectionRatios), _norm(tp.RefDirection.DirectionRatios)
    if not (_close(od[0], td[0]) and _close(od[1], td[1])):
        problems.append(f"{label}: placement direction {od} != IfcOpenShell {td}")
    for attribute in ("SegmentStart", "SegmentLength"):
        a, b = _measure(getattr(ours, attribute)), _measure(getattr(theirs, attribute))
        if not _close(a, b):
            problems.append(f"{label}: {attribute} {a} != IfcOpenShell {b}")
    ok, oparam = _parent_parameter(ours.ParentCurve)
    tk, tparam = _parent_parameter(theirs.ParentCurve)
    if ok != tk:
        problems.append(f"{label}: parent curve {ok} != IfcOpenShell {tk}")
    elif oparam is not None and not _close(oparam, tparam):
        problems.append(f"{label}: {ok} parameter {oparam} != IfcOpenShell {tparam}")


def _layout_segments(alignment):
    import ifcopenshell.api.alignment as A

    horizontal = A.get_horizontal_layout(alignment)
    return list(A.get_alignment_segment_nest(horizontal).RelatedObjects)


def check(path: str, authored: dict) -> list[str]:
    import ifcopenshell
    import ifcopenshell.geom
    import ifcopenshell.ifcopenshell_wrapper as W
    from ifcopenshell.api.alignment._map_alignment_horizontal_segment import _map_alignment_horizontal_segment

    model = ifcopenshell.open(path)
    alignments = model.by_type("IfcAlignment")
    problems: list[str] = []
    if not alignments:
        return ["no IfcAlignment in the file — nothing was checked"]

    settings = ifcopenshell.geom.settings()
    for alignment in alignments:
        name = alignment.Name
        if name not in authored:
            problems.append(f"alignment {name!r} has no authored boundary points to check against")
            continue
        boundaries = authored[name]
        layout = _layout_segments(alignment)
        curve = alignment.Representation.Representations[0].Items[0]
        ours = list(curve.Segments)
        # n authored segments + the zero-length terminator IFC 4.3 requires.
        if len(layout) != len(boundaries) or len(ours) != len(layout):
            problems.append(
                f"{name}: {len(layout)} layout segments / {len(ours)} curve segments for "
                f"{len(boundaries) - 1} authored segments (+1 terminator expected)"
            )
            continue
        terminator = layout[-1].DesignParameters
        if _measure(terminator.SegmentLength) != 0.0:
            problems.append(f"{name}: the last layout segment is not the zero-length terminator")
        if ours[-1].Transition != "DISCONTINUOUS":
            problems.append(f"{name}: the terminating curve segment is {ours[-1].Transition}, not DISCONTINUOUS")

        for index, (segment, our_curve) in enumerate(zip(layout, ours)):
            label = f"{name} segment {index + 1} ({segment.DesignParameters.PredefinedType})"
            theirs, _ = _map_alignment_horizontal_segment(model, segment)
            _compare_segment(our_curve, theirs, label, problems)

            if index == len(layout) - 1:
                continue  # zero length: its only point is the previous end
            fn = W.map_shape(settings, our_curve.wrapped_data)
            evaluator = W.function_item_evaluator(settings, fn)
            for which, param, expected in (("start", fn.start(), boundaries[index]), ("end", fn.end(), boundaries[index + 1])):
                matrix = evaluator.evaluate(param)
                x, y = matrix[0][3], matrix[1][3]
                miss = math.hypot(x - expected[0], y - expected[1])
                if miss > POSITION_TOLERANCE:
                    problems.append(
                        f"{label}: evaluated {which} ({x:.4f}, {y:.4f}) is {miss:.4f} from the authored "
                        f"({expected[0]:.4f}, {expected[1]:.4f})"
                    )
    return problems


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(__doc__)
        return 2
    try:
        import ifcopenshell  # noqa: F401
    except ImportError:
        print("check_alignment.py: ifcopenshell is not importable")
        return 3
    with open(argv[2], encoding="utf-8") as handle:
        authored = json.load(handle)
    # Accept the generator's full fixture as well as a bare name -> points map.
    authored = authored.get("authored", authored)
    problems = check(argv[1], authored)
    if problems:
        print(f"check_alignment.py: {len(problems)} problem(s). FAIL.")
        for problem in problems:
            print(f"  - {problem}")
        return 1
    print(f"check_alignment.py: {len(authored)} alignment(s) checked, 0 problems.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
