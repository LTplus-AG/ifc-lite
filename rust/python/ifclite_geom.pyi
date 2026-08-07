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
    # 16 floats, COLUMN-major 4x4, translation in metres at indices 12/13/14,
    # in the SAME absolute IFC world frame as geometry_data_buffers vertices.
    # None unless placements=True, or when the product has no ObjectPlacement.
    placement: Optional[List[float]]
    property_sets: List[PropertySet]
    quantity_sets: List[QuantitySet]
    # Type-specific IFC attributes (e.g. IfcReinforcingBar.NominalDiameter),
    # named and ordered as the schema declares them. NOT property sets.
    attributes: List[PropValue]

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

def entity_data(
    ifc_bytes: bytes,
    placements: bool = False,
    type_properties: bool = True,
    attributes: bool = True,
) -> EntityData:
    """Read attributes, property sets and quantity sets. No tessellation.

    ``entities`` is keyed by IFC STEP id in file order, so it joins directly
    against ``geometry_data_buffers(...)["elements"]``. The join is one-way
    total: every meshed element has a row here, but not every row has an
    element. Besides products with no geometry, an orphan ``IfcTypeProduct``
    gets a row with ``has_geometry=True`` and still never appears in
    ``elements``, because the geometry functions emit occurrences only. Drive
    the join from ``elements``, or use ``.get()``.

    Property values are strings and quantity values are floats, both in the
    file's OWN units -- a millimetre model reports a length of ``3000`` where
    geometry from this module is always metres.

    Converting is per dimension, not one blanket factor: multiply a ``Length``
    by ``length_unit_scale``, an ``Area`` by its SQUARE and a ``Volume`` by its
    CUBE, and use ``plane_angle_to_radians`` for angles. ``Count`` is
    dimensionless. Only the length and plane-angle scales are resolved, so a
    model declaring an area or volume unit inconsistent with its length unit
    cannot be reconciled from what is returned here.

    Pass ``placements=True`` to resolve each product's ``ObjectPlacement``;
    it is off by default because it costs an extra decode per product. The
    resulting matrix is in the same absolute IFC world frame as
    ``geometry_data_buffers`` vertices, so the two line up directly. Do not
    fold ``rtc_offset`` into either: the geometry export already adds it back
    into every vertex, and this placement is never RTC-rebased.

    ``type_properties`` (on by default) also returns what each occurrence
    inherits from its ``IfcTypeObject`` through ``IfcRelDefinesByType``. A type
    attaches its sets via ``HasPropertySets`` and gets no row of its own unless
    it carries orphan geometry, so without this the properties authoring tools
    put on types are unreachable. The merge is per property:

    * A type set whose name the occurrence does not use is added whole.
    * A type set sharing a name contributes only the properties the occurrence
      does not already define, so the occurrence wins a collision and the
      type-only properties beside it still survive.

    Pass ``type_properties=False`` for own-sets-only, as in 4.3.0.

    Remaining limit, inherited from the shared export model: only
    ``IfcPropertySingleValue`` properties are decoded. Enumerated, list,
    bounded, table and reference properties are skipped silently, and the pset
    still appears with those entries missing.

    ``attributes`` (on by default) returns each entity's TYPE-SPECIFIC IFC
    attributes, which are not property sets and which no amount of pset work
    surfaces. ``IfcReinforcingBar`` yields ``SteelGrade``, ``NominalDiameter``,
    ``CrossSectionArea``, ``BarLength``, ``PredefinedType``, ``BarSurface`` and
    ``Tag``; ``IfcDoor`` yields ``OverallHeight`` / ``OverallWidth``, and so on
    for every type, named and ordered as the schema declares them.

    Entries share the ``{name, value, value_type}`` shape of a property, so one
    code path reads both. Fields this dict already carries (``global_id``,
    ``name``, ``description``, ``object_type``) are not repeated, and
    reference-valued attributes are omitted rather than rendered as a dangling
    id.

    Raises:
        RuntimeError: the extraction pipeline failed.
    """
    ...
