# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
#
# Type stubs for the ifclite-geom native extension.
# Shipped next to the compiled module so editors and type checkers see the API.
from typing import Any, Dict, List, Optional, TypedDict

class ElementBuffers(TypedDict):
    ifc_type: str
    global_id: Optional[str]
    name: Optional[str]
    color: List[float]  # [r, g, b, a] in 0..1
    vertices: bytes  # f64 little-endian, xyz triplets
    faces: bytes  # u32 little-endian, triangle indices

class GeometryBuffers(TypedDict):
    up_axis: str  # always "Z"
    units: str  # always "m"
    rtc_offset: List[float]  # [x, y, z], already folded into vertices
    element_count: int
    elements: Dict[int, ElementBuffers]  # keyed by IFC STEP id

def geometry_data_buffers(ifc_bytes: bytes) -> GeometryBuffers:
    """Tessellate IFC bytes; return per-entity geometry with vertices/faces as
    raw little-endian byte buffers (f64 xyz triplets, u32 triangle indices) for
    ``numpy.frombuffer``.

    Vertices are welded, IFC Z-up, absolute-world metres, keyed by IFC STEP id
    (occurrences only). ``ifc_bytes`` is the raw IFC file content, e.g.
    ``open(path, "rb").read()``.

    Raises:
        RuntimeError: the geometry pipeline failed.
    """
    ...

def geometry_data_json(ifc_bytes: bytes) -> str:
    """Tessellate IFC bytes; return the ``ifc-lite-geometry-data`` JSON document
    as a string (call ``json.loads`` on it).

    Same geometry as :func:`geometry_data_buffers`, but vertices/faces are JSON
    arrays (no numpy needed) and each element also carries ``global_id`` and
    ``name`` when present.

    Raises:
        RuntimeError: the geometry pipeline failed.
        ValueError: JSON serialization failed.
    """
    ...
