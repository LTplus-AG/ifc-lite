#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Author a SYNTHETIC, geometrically consistent LandXML horizontal alignment.

Writes `alignment_fixture.json`: the alignments in ifc-lite's LandXML source
shape (northing-first, as LandXML authors them) plus every segment boundary as
(easting, northing). The boundaries are computed HERE, by this script's own
integration — independent of ifc-lite's TypeScript mapping — so a check of
ifc-lite's output against them is not ifc-lite checking itself.

Synthetic by construction: it proves the mapping's invariants (axis order,
radius sign, clothoid constant and offset, continuity). It certifies no vendor
export.
"""

from __future__ import annotations

import json
import math
import os

STEPS = 20000


def integrate(x, y, heading, k0, k1, length):
    """Position/heading after `length` along linearly varying curvature."""
    if length == 0:
        return x, y, heading
    h = length / STEPS
    sx = sy = 0.0
    for i in range(STEPS + 1):
        s = i * h
        theta = heading + k0 * s + (k1 - k0) * s * s / (2 * length)
        w = 1 if i in (0, STEPS) else (4 if i % 2 else 2)
        sx += w * math.cos(theta)
        sy += w * math.sin(theta)
    end_heading = heading + k0 * length + (k1 - k0) * length / 2
    return x + sx * h / 3, y + sy * h / 3, end_heading


def loc(x, y):
    # LandXML authors plan points northing-first.
    return {"kind": "coordinates", "point": {"northing": round(y, 6), "easting": round(x, 6)}}


def build(name, source_id, start, heading_deg, parts, sta_start):
    x, y = start
    heading = math.radians(heading_deg)
    boundaries = [[round(x, 6), round(y, 6)]]
    segments = []
    for ordinal, part in enumerate(parts):
        kind = part["kind"]
        length = part["length"]
        sign = 1 if part.get("rotation", "counter_clockwise") == "counter_clockwise" else -1
        if kind == "line":
            k0 = k1 = 0.0
        elif kind == "curve":
            k0 = k1 = sign / part["radius"]
        else:
            r0, r1 = part["radiusStart"], part["radiusEnd"]
            k0 = 0.0 if r0 == "infinite" else sign / r0
            k1 = 0.0 if r1 == "infinite" else sign / r1
        ex, ey, eh = integrate(x, y, heading, k0, k1, length)
        seg_id = f"{source_id}:segment:{ordinal}"
        if kind == "line":
            primitive = {"kind": "line", "start": loc(x, y), "end": loc(ex, ey), "declaredLength": length}
        elif kind == "curve":
            radius = part["radius"]
            # Centre: a radius to the LEFT of travel for a counter-clockwise arc.
            cx = x + radius * math.cos(heading + sign * math.pi / 2)
            cy = y + radius * math.sin(heading + sign * math.pi / 2)
            primitive = {
                "kind": "curve", "start": loc(x, y), "center": loc(cx, cy), "end": loc(ex, ey),
                "rotation": part["rotation"], "radius": radius, "declaredLength": length,
            }
        else:
            # PI: intersection of the start tangent and the end tangent.
            dx0, dy0 = math.cos(heading), math.sin(heading)
            dx1, dy1 = math.cos(eh), math.sin(eh)
            denom = dx0 * dy1 - dy0 * dx1
            t = ((ex - x) * dy1 - (ey - y) * dx1) / denom
            px, py = x + t * dx0, y + t * dy0
            primitive = {
                "kind": "spiral", "spiType": "clothoid", "start": loc(x, y), "pi": loc(px, py),
                "end": loc(ex, ey), "radiusStart": part["radiusStart"], "radiusEnd": part["radiusEnd"],
                "rotation": part["rotation"], "declaredLength": length,
            }
        segments.append({"sourceId": seg_id, "ordinal": ordinal, "primitive": primitive})
        boundaries.append([round(ex, 6), round(ey, 6)])
        x, y, heading = ex, ey, eh
    alignment = {"sourceId": source_id, "name": name, "staStart": sta_start, "segments": segments}
    return alignment, boundaries


def main():
    left, left_b = build(
        "A-Left", "landxml:alignment:1", (157800.0, 6406900.0), 30.0,
        [
            {"kind": "line", "length": 120.0},
            {"kind": "spiral", "length": 80.0, "radiusStart": "infinite", "radiusEnd": 300.0, "rotation": "counter_clockwise"},
            {"kind": "curve", "length": 150.0, "radius": 300.0, "rotation": "counter_clockwise"},
            {"kind": "spiral", "length": 80.0, "radiusStart": 300.0, "radiusEnd": "infinite", "rotation": "counter_clockwise"},
            {"kind": "line", "length": 100.0},
        ],
        1000.0,
    )
    right, right_b = build(
        "A-Right", "landxml:alignment:2", (158500.0, 6407200.0), 100.0,
        [
            {"kind": "line", "length": 60.0},
            {"kind": "spiral", "length": 45.0, "radiusStart": "infinite", "radiusEnd": 150.0, "rotation": "clockwise"},
            {"kind": "curve", "length": 120.0, "radius": 150.0, "rotation": "clockwise"},
            # Compound spiral: starts at a FINITE radius — exercises the
            # clothoid SegmentStart offset, the easiest term to get wrong.
            {"kind": "spiral", "length": 60.0, "radiusStart": 150.0, "radiusEnd": 400.0, "rotation": "clockwise"},
            {"kind": "spiral", "length": 50.0, "radiusStart": 400.0, "radiusEnd": "infinite", "rotation": "clockwise"},
            {"kind": "line", "length": 80.0},
        ],
        0.0,
    )
    compound, compound_b = build(
        "A-Compound", "landxml:alignment:3", (159100.0, 6406500.0), -45.0,
        [
            {"kind": "line", "length": 70.0},
            {"kind": "spiral", "length": 40.0, "radiusStart": "infinite", "radiusEnd": 600.0, "rotation": "counter_clockwise"},
            # Radius DECREASES between two finite values — the one clothoid
            # branch whose SegmentStart offset uses `L·R1 / (R0 − R1)`. Without
            # this case that branch can be broken with every check still green.
            {"kind": "spiral", "length": 55.0, "radiusStart": 600.0, "radiusEnd": 250.0, "rotation": "counter_clockwise"},
            {"kind": "curve", "length": 90.0, "radius": 250.0, "rotation": "counter_clockwise"},
            {"kind": "spiral", "length": 65.0, "radiusStart": 250.0, "radiusEnd": "infinite", "rotation": "counter_clockwise"},
            {"kind": "line", "length": 50.0},
        ],
        250.0,
    )
    fixture = {
        "synthetic": True,
        "generator": "tools/ifcopenshell_reference/make_alignment_fixture.py",
        "alignments": [left, right, compound],
        "authored": {"A-Left": left_b, "A-Right": right_b, "A-Compound": compound_b},
    }
    out = os.path.join(os.path.dirname(__file__), "alignment_fixture.json")
    with open(out, "w", encoding="utf-8") as handle:
        json.dump(fixture, handle, indent=1)
        handle.write("\n")
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
