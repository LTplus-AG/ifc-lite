#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Author SYNTHETIC, geometrically consistent LandXML alignments and profiles.

Writes `alignment_fixture.json`: the alignments in ifc-lite's LandXML source
shape (northing-first, as LandXML authors them) plus every segment boundary as
(easting, northing). The boundaries are computed HERE, by this script's own
integration — independent of ifc-lite's TypeScript mapping — so a check of
ifc-lite's output against them is not ifc-lite checking itself.

Since mapping v1.2 (spec §12) it also writes design profiles (`profiles`, in the
viewer's `LandXmlProfile` shape) and `authoredVertical`: for each profiled
alignment, the height of the LandXML-defined profile at every PVI station and
at every vertical-curve boundary and quarter point, evaluated HERE from the
LandXML definition of each curve (see `profile_height`), not from ifc-lite's
IFC segments.

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


def curvatures(part):
    sign = 1 if part.get("rotation", "counter_clockwise") == "counter_clockwise" else -1
    if part["kind"] == "line":
        return 0.0, 0.0
    if part["kind"] == "curve":
        return sign / part["radius"], sign / part["radius"]
    r0, r1 = part["radiusStart"], part["radiusEnd"]
    return (0.0 if r0 == "infinite" else sign / r0), (0.0 if r1 == "infinite" else sign / r1)


def point_at(start, heading_deg, parts, distance):
    """(easting, northing) at `distance` along the parts — this script's own integration."""
    x, y = start
    heading = math.radians(heading_deg)
    for part in parts:
        k0, k1 = curvatures(part)
        length = part["length"]
        if distance <= length:
            # Curvature varies linearly over the WHOLE part, so the partial
            # integral uses the part's rate, not one rescaled to `distance`.
            k_at = k0 + (k1 - k0) * distance / length
            px, py, _ = integrate(x, y, heading, k0, k_at, distance)
            return [round(px, 6), round(py, 6)]
        x, y, heading = integrate(x, y, heading, k0, k1, length)
        distance -= length
    raise ValueError("distance beyond the alignment")


def station_equations(source_id, sta_start, start, heading_deg, parts, authored):
    """StaEquation records plus what a reader must find for each (§14).

    `authored` rows: (staInternal, staAhead, staBack or None, staIncrement or None).
    The expected IncomingStation for an absent staBack follows the running
    stationing, as rust/landxml's station_mapping derives it.
    """
    records, expected = [], []
    displayed, previous, direction = sta_start, sta_start, 1
    for ordinal, (internal, ahead, back, increment) in enumerate(authored, start=1):
        records.append({
            "sourceId": f"{source_id}:station-equation:{ordinal}", "staInternal": internal,
            "staAhead": ahead, "staBack": back, "staIncrement": increment,
        })
        expected.append({
            "distanceAlong": internal - sta_start,
            "station": ahead,
            "incomingStation": back if back is not None else displayed + direction * (internal - previous),
            "hasIncreasingStation": None if increment is None else increment == "increasing",
            "point": point_at(start, heading_deg, parts, internal - sta_start),
        })
        displayed, previous = ahead, internal
        direction = -1 if increment == "decreasing" else 1
    return records, expected


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


def circular_geometry(g1, g2, radius):
    """Tangent length and horizontal length of a circular vertical curve."""
    t1, t2 = math.atan(g1), math.atan(g2)
    return radius * math.tan(abs(t2 - t1) / 2), radius * abs(math.sin(t2) - math.sin(t1))


def profile_height(pvis, curves, station):
    """Height of a LandXML design profile at `station`, straight from its definition.

    `pvis`: [(station, elevation)], `curves`: {pvi index: curve dict}. Grades
    run PVI to PVI; a curve replaces the grades around its PVI over its extent.
    """
    for index, curve in curves.items():
        (s0, e0), (s1, e1), (s2, e2) = pvis[index - 1], pvis[index], pvis[index + 1]
        g1, g2 = (e1 - e0) / (s1 - s0), (e2 - e1) / (s2 - s1)
        if curve["kind"] == "parabolic":
            half = curve["length"] / 2
            if s1 - half <= station <= s1 + half:
                x = station - (s1 - half)
                return e1 - g1 * half + g1 * x + (g2 - g1) * x * x / (2 * curve["length"])
        elif curve["kind"] == "unsymmetrical_parabolic":
            lin, lout = curve["lengthIn"], curve["lengthOut"]
            if s1 - lin <= station <= s1 + lout:
                # y(x) = e1 - g1*lin + g1*x + k*x^2 on the first leg, and the
                # mirror form from the end on the second: both legs meet the
                # tangents, and share height and slope at the PVI station.
                total = lin + lout
                r_in = (g2 - g1) * lout / (lin * total)
                r_out = (g2 - g1) * lin / (lout * total)
                if station <= s1:
                    x = station - (s1 - lin)
                    return e1 - g1 * lin + g1 * x + r_in * x * x / 2
                x = (s1 + lout) - station
                return e1 + g2 * lout - g2 * x + r_out * x * x / 2
        else:
            radius = curve["radius"]
            tangent, _ = circular_geometry(g1, g2, radius)
            t1 = math.atan(g1)
            bvc = (s1 - tangent * math.cos(t1), e1 - tangent * math.sin(t1))
            t2 = math.atan(g2)
            evc_station = s1 + tangent * math.cos(t2)
            if bvc[0] <= station <= evc_station:
                side = 1 if g2 > g1 else -1  # sag: centre above the curve
                cx = bvc[0] - side * radius * math.sin(t1)
                cy = bvc[1] + side * radius * math.cos(t1)
                return cy - side * math.sqrt(radius * radius - (station - cx) ** 2)
    for (s0, e0), (s1, e1) in zip(pvis, pvis[1:]):
        if s0 <= station <= s1:
            return e0 + (e1 - e0) * (station - s0) / (s1 - s0)
    raise ValueError(f"station {station} is outside the profile")


def build_profile(alignment, name, pvis, curves):
    """A `ProfAlign` in the viewer's shape, plus its independently evaluated heights."""
    source_id = f"landxml:profile:{alignment['sourceId']}:1:design:{name}"
    alignment["profileSourceIds"] = [source_id]
    points, vertical_curves = [], []
    stations = set()
    for index, (station, elevation) in enumerate(pvis):
        points.append({"sourceId": f"{source_id}:pvi:{index + 1}", "station": station, "elevation": elevation})
        stations.add(station)
        curve = curves.get(index)
        if curve is None:
            continue
        g1 = (elevation - pvis[index - 1][1]) / (station - pvis[index - 1][0])
        g2 = (pvis[index + 1][1] - elevation) / (pvis[index + 1][0] - station)
        record = {
            "sourceId": f"{source_id}:curve:{len(vertical_curves) + 1}", "kind": curve["kind"],
            "station": station, "elevation": elevation,
            "length": None, "lengthIn": None, "lengthOut": None, "radius": None,
        }
        if curve["kind"] == "parabolic":
            record["length"] = curve["length"]
            ends = (station - curve["length"] / 2, station + curve["length"] / 2)
        elif curve["kind"] == "unsymmetrical_parabolic":
            record["lengthIn"], record["lengthOut"] = curve["lengthIn"], curve["lengthOut"]
            ends = (station - curve["lengthIn"], station + curve["lengthOut"])
        else:
            tangent, horizontal = circular_geometry(g1, g2, curve["radius"])
            # LandXML's CircCurve length, read as the HORIZONTAL length (§12.4).
            record["radius"], record["length"] = curve["radius"], round(horizontal, 6)
            ends = (station - tangent * math.cos(math.atan(g1)), station + tangent * math.cos(math.atan(g2)))
        vertical_curves.append(record)
        for q in range(5):
            stations.add(ends[0] + (ends[1] - ends[0]) * q / 4)
    profile = {
        "sourceId": source_id, "parentAlignmentSourceId": alignment["sourceId"], "ordinal": 1, "name": name,
        "kind": "design", "pvis": points, "verticalCurves": vertical_curves, "gradeLines": [],
    }
    heights = [[round(s, 9), profile_height(pvis, curves, s)] for s in sorted(stations)]
    return profile, {"staStart": alignment["staStart"], "heights": heights}


def displayed(internal, sta_start, authored):
    """The displayed station at an internal station, as rust/landxml's station_mapping reads it."""
    value, previous, direction = sta_start, sta_start, 1
    for eq_internal, ahead, _back, increment in authored:
        if internal < eq_internal:
            break
        value, previous = ahead, eq_internal
        direction = -1 if increment == "decreasing" else 1
    return value + direction * (internal - previous)


def displayed_stations(profile, sta_start, authored):
    """Re-author a profile designed in internal stations in DISPLAYED ones (§14.5)."""
    for record in profile["pvis"] + profile["verticalCurves"]:
        record["station"] = round(displayed(record["station"], sta_start, authored), 9)

def main():
    LEFT = ((157800.0, 6406900.0), 30.0,
        [
            {"kind": "line", "length": 120.0},
            {"kind": "spiral", "length": 80.0, "radiusStart": "infinite", "radiusEnd": 300.0, "rotation": "counter_clockwise"},
            {"kind": "curve", "length": 150.0, "radius": 300.0, "rotation": "counter_clockwise"},
            {"kind": "spiral", "length": 80.0, "radiusStart": 300.0, "radiusEnd": "infinite", "rotation": "counter_clockwise"},
            {"kind": "line", "length": 100.0},
        ],
    )
    RIGHT = ((158500.0, 6407200.0), 100.0,
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
    )
    left, left_b = build("A-Left", "landxml:alignment:1", *LEFT, 1000.0)
    right, right_b = build("A-Right", "landxml:alignment:2", *RIGHT, 0.0)
    COMPOUND = ((159100.0, 6406500.0), -45.0,
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
    )
    compound, compound_b = build("A-Compound", "landxml:alignment:3", *COMPOUND, 250.0)
    # Station equations (§14), and a profile read through them (§14.5).
    #
    # A-Left: ONE forward jump (internal 1200 -> displayed 1250) under its
    # profile. The profile is designed in internal stations, exactly as before,
    # and its PVIs and curves are then AUTHORED in displayed stations — so the
    # IFC must carry the same geometry as without the jump, which only a
    # correct station-to-distance mapping produces.
    #
    # A-Compound (no profile): a backward jump to below the start station (the
    # case where ordering by Station and ordering along the alignment differ),
    # a decreasing run starting inside the finite-start clothoid, then an
    # equation with no staBack (a derived IncomingStation) inside the last
    # spiral. A-Right keeps none.
    referents = {}
    left_equations = [(1200.0, 1250.0, 1200.0, "increasing")]
    for alignment, start, heading_deg, parts, authored in (
        (left, *LEFT, left_equations),
        (compound, *COMPOUND, [
            (330.0, 200.0, 330.0, "increasing"), (400.0, 500.0, 270.0, "decreasing"), (520.0, 2000.0, None, "increasing"),
        ]),
    ):
        records, expected = station_equations(
            alignment["sourceId"], alignment["staStart"], start, heading_deg, parts, authored,
        )
        alignment["stationEquations"] = records
        referents[alignment["name"]] = {"startStation": alignment["staStart"], "equations": expected}
    referents["A-Right"] = {"startStation": right["staStart"], "equations": []}

    # A-Left: a CREST parabola, a bare grade break, then a SAG circular arc.
    left_profile, left_v = build_profile(
        left, "P-Left",
        [(1000.0, 20.0), (1150.0, 23.0), (1300.0, 21.5), (1420.0, 18.9), (1530.0, 20.0)],
        {1: {"kind": "parabolic", "length": 80.0}, 3: {"kind": "circular", "radius": 2000.0}},
    )
    displayed_stations(left_profile, left["staStart"], left_equations)
    # A-Right: a SAG parabola, then an UNSYMMETRICAL crest (unequal legs).
    right_profile, right_v = build_profile(
        right, "P-Right",
        [(0.0, 50.0), (120.0, 47.0), (260.0, 49.8), (415.0, 46.7)],
        {1: {"kind": "parabolic", "length": 100.0}, 2: {"kind": "unsymmetrical_parabolic", "lengthIn": 40.0, "lengthOut": 70.0}},
    )
    # A-Compound stays horizontal-only: one file carries both kinds (§12.1).
    fixture = {
        "synthetic": True,
        "generator": "tools/ifcopenshell_reference/make_alignment_fixture.py",
        "alignments": [left, right, compound],
        "profiles": [left_profile, right_profile],
        "authored": {"A-Left": left_b, "A-Right": right_b, "A-Compound": compound_b},
        "authoredVertical": {"A-Left": left_v, "A-Right": right_v},
        "referents": referents,
    }
    out = os.path.join(os.path.dirname(__file__), "alignment_fixture.json")
    with open(out, "w", encoding="utf-8") as handle:
        json.dump(fixture, handle, indent=1)
        handle.write("\n")
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
