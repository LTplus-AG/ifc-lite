# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
#
# Type stubs for the ifclite-geom native extension.
# Shipped next to the compiled module so editors and type checkers see the API.
from typing import Any, Dict, List, Literal, Optional, TypedDict

Quality = Literal["lowest", "low", "medium", "high", "highest"]

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

class PropValue(TypedDict):
    name: str
    value: str  # always a string, in the file's OWN units
    value_type: str  # e.g. "IFCLABEL", "IFCREAL", "IFCBOOLEAN"

class PropertySet(TypedDict):
    name: str
    properties: List[PropValue]

class QuantityValue(TypedDict):
    name: str
    value: float  # in the file's OWN units
    kind: str  # "Length" | "Area" | "Volume" | "Count" | "Weight" | "Time"

class QuantitySet(TypedDict):
    name: str
    quantities: List[QuantityValue]

class EntityRow(TypedDict):
    ifc_type: str
    global_id: Optional[str]
    name: Optional[str]
    description: Optional[str]
    object_type: Optional[str]
    has_geometry: bool
    # 16 floats, COLUMN-major 4x4, IFC world frame, translation in metres at
    # indices 12/13/14. None unless placements=True, or when the product has no
    # ObjectPlacement.
    placement: Optional[List[float]]
    property_sets: List[PropertySet]
    quantity_sets: List[QuantitySet]

class EntityData(TypedDict):
    length_unit_scale: float  # file length unit -> metres (0.001 for mm files)
    plane_angle_to_radians: float
    project_id: Optional[int]
    entity_count: int
    entities: Dict[int, EntityRow]  # keyed by IFC STEP id, in file order

def geometry_data_buffers(
    ifc_bytes: bytes, quality: Optional[Quality] = None
) -> GeometryBuffers:
    """Tessellate IFC bytes; return per-entity geometry with vertices/faces as
    raw little-endian byte buffers (f64 xyz triplets, u32 triangle indices) for
    ``numpy.frombuffer``.

    Vertices are welded, IFC Z-up, absolute-world metres, keyed by IFC STEP id
    (occurrences only). ``ifc_bytes`` is the raw IFC file content, e.g.
    ``open(path, "rb").read()``.

    ``quality`` scales the segment count on every curved primitive (swept-disk
    tubes, cylinders, revolutions, arcs). ``None`` means ``"medium"``, the
    engine default. Each step is a factor of two in density, so ``"lowest"``
    is roughly a tenth of ``"medium"``'s triangle budget on curve-heavy
    elements such as reinforcing bars.

    Raises:
        RuntimeError: the geometry pipeline failed.
        ValueError: ``quality`` is not a recognised label.
    """
    ...

def geometry_data_json(ifc_bytes: bytes, quality: Optional[Quality] = None) -> str:
    """Tessellate IFC bytes; return the ``ifc-lite-geometry-data`` JSON document
    as a string (call ``json.loads`` on it).

    Same geometry as :func:`geometry_data_buffers`, but vertices/faces are JSON
    arrays (no numpy needed) and each element also carries ``global_id`` and
    ``name`` when present. ``quality`` is as documented there.

    Raises:
        RuntimeError: the geometry pipeline failed.
        ValueError: ``quality`` is not a recognised label, or JSON
            serialization failed.
    """
    ...

def entity_data(ifc_bytes: bytes, placements: bool = False) -> EntityData:
    """Read attributes, property sets and quantity sets. No tessellation.

    ``entities`` is keyed by IFC STEP id in file order, so it joins directly
    against ``geometry_data_buffers(...)["elements"]``.

    Property values are strings and quantity values are floats, both in the
    file's OWN units -- a millimetre model reports a length of ``3000`` where
    geometry from this module is always metres. Multiply dimensional values by
    ``length_unit_scale`` to reconcile the two.

    Pass ``placements=True`` to resolve each product's ``ObjectPlacement``;
    it is off by default because it costs an extra decode per product. The
    resulting matrix is in the IFC world frame, which is neither RTC-shifted
    nor Y-up, so it does not line up with ``geometry_data_buffers`` vertices
    without folding ``rtc_offset``.

    Known limits, inherited from the shared export model:

    * Only ``IfcPropertySingleValue`` properties are decoded. Enumerated,
      list, bounded, table and reference properties are skipped silently --
      the pset still appears, with those entries missing.
    * Type-level properties surface only for types that carry orphan geometry.
      A type attaches its sets via ``IfcTypeObject.HasPropertySets``, and a
      type gets a row here only when it also has ``RepresentationMaps`` that
      get meshed; such a row does carry its psets. A plain ``IfcWallType``
      holding ``Pset_WallCommon`` has no representation, so it yields no row at
      all, and is not merged into the occurrences that inherit it through
      ``IfcRelDefinesByType`` either. That is the common case, and authoring
      tools put a lot on types, so treat a missing property as "not asked for
      yet", not "absent from the file".

    Raises:
        RuntimeError: the extraction pipeline failed.
    """
    ...
