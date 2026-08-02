# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""Canonical per-element geometry stats, shared by BOTH dumpers.

Every stat both sides of the differential comparison report is computed by
the functions in this file, from plain vertex/face arrays. That way the
comparison only ever measures the GEOMETRY, never a difference in how a stat
was computed.

Conventions (must match on both sides):
- vertices: flat list [x0, y0, z0, x1, ...] in absolute world METRES, Z-up,
  WELDED (the reference engine runs weld-vertices=True; the ifc-lite side
  comes pre-welded from ``ifclite_geom.geometry_data_buffers``).
- faces: flat list of vertex indices, triangles only.
- floats are rounded to ROUND_DECIMALS before serialization so trivial float
  noise between engine builds does not create diffs (6 decimals of a metre =
  sub-micron stability).
"""

from __future__ import annotations

ROUND_DECIMALS = 6

# Stat schema version for the emitted JSON documents.
SCHEMA_VERSION = 1


def _r(v: float) -> float:
    rounded = round(v, ROUND_DECIMALS)
    # Avoid -0.0 vs 0.0 diffs between engines.
    return 0.0 if rounded == 0 else rounded


def bbox(vertices: list[float]) -> dict:
    """Axis-aligned bounding box {min: [x,y,z], max: [x,y,z]} of a flat
    vertex list, rounded. Raises ValueError on an empty list."""
    if not vertices:
        raise ValueError("bbox of empty vertex list")
    xs = vertices[0::3]
    ys = vertices[1::3]
    zs = vertices[2::3]
    return {
        "min": [_r(min(xs)), _r(min(ys)), _r(min(zs))],
        "max": [_r(max(xs)), _r(max(ys)), _r(max(zs))],
    }


def tri_count(faces: list[int]) -> int:
    return len(faces) // 3


def vertex_count(vertices: list[float]) -> int:
    return len(vertices) // 3


def signed_volume(vertices: list[float], faces: list[int]) -> float:
    """Signed volume via the divergence theorem (sum of signed tetrahedra
    against the origin). Only meaningful for closed meshes; the comparator
    takes abs() and applies a relative tolerance, and skips it when either
    side marks the mesh open."""
    total = 0.0
    for i in range(0, len(faces) - 2, 3):
        a, b, c = faces[i] * 3, faces[i + 1] * 3, faces[i + 2] * 3
        ax, ay, az = vertices[a], vertices[a + 1], vertices[a + 2]
        bx, by, bz = vertices[b], vertices[b + 1], vertices[b + 2]
        cx, cy, cz = vertices[c], vertices[c + 1], vertices[c + 2]
        total += (
            ax * (by * cz - bz * cy)
            - ay * (bx * cz - bz * cx)
            + az * (bx * cy - by * cx)
        )
    return total / 6.0


def is_closed(faces: list[int]) -> bool:
    """True when every edge is shared by exactly two triangles (watertight),
    counting undirected edges."""
    from collections import Counter

    edges: Counter = Counter()
    for i in range(0, len(faces) - 2, 3):
        tri = (faces[i], faces[i + 1], faces[i + 2])
        for e in ((tri[0], tri[1]), (tri[1], tri[2]), (tri[2], tri[0])):
            edges[tuple(sorted(e))] += 1
    return bool(edges) and all(n == 2 for n in edges.values())


def element_record(express_id: int, ifc_type: str, vertices: list[float], faces: list[int]) -> dict:
    """The canonical per-element record both dumpers emit for an element the
    engine processed successfully."""
    closed = is_closed(faces)
    return {
        "express_id": express_id,
        "ifc_type": ifc_type,
        "status": "ok",
        "bbox": bbox(vertices),
        "vertex_count": vertex_count(vertices),
        "tri_count": tri_count(faces),
        "volume": _r(abs(signed_volume(vertices, faces))) if closed else None,
        "closed": closed,
    }


def skip_record(express_id: int, ifc_type: str, reason: str) -> dict:
    """First-class 'the engine could not process this element' outcome."""
    return {
        "express_id": express_id,
        "ifc_type": ifc_type,
        "status": f"skip:{reason}",
        "bbox": None,
        "vertex_count": 0,
        "tri_count": 0,
        "volume": None,
        "closed": False,
    }


def document(fixture: str, sha256: str, engine: str, settings: dict, elements: list[dict]) -> dict:
    """One JSON document per fixture, elements sorted by express id."""
    return {
        "version": SCHEMA_VERSION,
        "fixture": fixture,
        "sha256": sha256,
        "engine": engine,
        "settings": settings,
        "elements": sorted(elements, key=lambda e: e["express_id"]),
    }
