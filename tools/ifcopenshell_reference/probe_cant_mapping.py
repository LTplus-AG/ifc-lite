#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Can IfcOpenShell serve as the independent oracle for cant geometry?

WHY. Every alignment the LandXML->IFC mapping writes is graded by IfcOpenShell
regenerating its geometry from the semantics (check_alignment.py, mapping spec
section 11.6). Cant would need the same: IfcOpenShell regenerating the
IfcSegmentedReferenceCurve segments from our IfcAlignmentCantSegment through
its own `_map_alignment_cant_segment`. Section 13.2 of the mapping spec refuses
cant partly because the pinned IfcOpenShell cannot do that correctly. This
script measures that premise, so the refusal is re-examined the day it stops
being true (a pinned-version bump that fixes the mapping turns the test that
runs this script red).

Three probes, each on a single IfcAlignmentCantSegment over 100 m with a rail
head distance of 1.5 m:

1. MIRROR. Constant cant 0.15 m with the LEFT rail raised, and the same with
   the RIGHT rail raised. Mirrored input must give mirrored cross slope; the
   pinned mapping derives the segment placement from the mean rail height
   only, so the two come out identical.
2. CENTRE. Constant cant 0.15 m rotated about the track centre (left +0.075,
   right -0.075). The track is tilted; the pinned mapping writes an untilted
   placement axis.
3. RAMP. A linear transition from no cant to that centre-rotated cant. The
   pinned mapping raises ZeroDivisionError.

Prints one JSON object and exits 0 when the probes ran; the caller judges the
findings. Exit 3 when ifcopenshell is not importable.

Usage:
    python3 probe_cant_mapping.py
"""

from __future__ import annotations

import json
import sys

RAIL_HEAD_DISTANCE = 1.5


def _placement(file, left: float, right: float, end_left=None, end_right=None, kind="CONSTANTCANT"):
    from ifcopenshell.api.alignment._map_alignment_cant_segment import _map_alignment_cant_segment

    parameters = file.createIfcAlignmentCantSegment(
        StartDistAlong=0.0,
        HorizontalLength=100.0,
        StartCantLeft=left,
        StartCantRight=right,
        EndCantLeft=end_left,
        EndCantRight=end_right,
        PredefinedType=kind,
    )
    segment = file.createIfcAlignmentSegment(GlobalId="0" * 22, DesignParameters=parameters)
    curve_segment, _ = _map_alignment_cant_segment(file, segment, RAIL_HEAD_DISTANCE)
    placement = curve_segment.Placement
    return {
        "location": [round(float(v), 9) for v in placement.Location.Coordinates],
        "axis": [round(float(v), 9) for v in placement.Axis.DirectionRatios],
    }


def probe() -> dict:
    import ifcopenshell

    file = ifcopenshell.file(schema="IFC4X3_ADD2")
    left_raised = _placement(file, 0.15, 0.0)
    right_raised = _placement(file, 0.0, 0.15)
    centre = _placement(file, 0.075, -0.075)
    try:
        _placement(file, 0.0, 0.0, 0.075, -0.075, "LINEARTRANSITION")
        ramp = "mapped"
    except ZeroDivisionError:
        ramp = "ZeroDivisionError"
    return {
        "ifcopenshell": ifcopenshell.version,
        "left_raised": left_raised,
        "right_raised": right_raised,
        # A mirror-blind mapping cannot be the oracle: it would pass a cant
        # written on the wrong rail.
        "mirror_distinguished": left_raised != right_raised,
        "centre_rotation": centre,
        "centre_rotation_tilted": centre["axis"][1] != 0.0,
        "centre_linear_transition": ramp,
    }


def main() -> int:
    try:
        import ifcopenshell  # noqa: F401
    except ImportError:
        print("probe_cant_mapping.py: ifcopenshell is not importable")
        return 3
    print(json.dumps(probe()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
