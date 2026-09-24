# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
#
# Type stubs for the ifclite-geom native extension.
# Shipped next to the compiled module so editors and type checkers see the API.
from typing import Any, Dict, List, Literal, Optional, Set, TypedDict, Union, overload

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

class DirectrixLine(TypedDict):
    type: Literal["line"]
    start: List[float]
    end: List[float]

class DirectrixArc(TypedDict):
    type: Literal["arc"]
    center: List[float]
    normal: List[float]
    x_axis: List[float]
    radius: float
    start_angle: float
    sweep_angle: float

DirectrixSegment = Union[DirectrixLine, DirectrixArc]

class CompleteDirectrix(TypedDict):
    type: Literal["complete"]

class UnsupportedDirectrix(TypedDict):
    type: Literal["unsupported"]
    reason: str

DirectrixStatus = Union[CompleteDirectrix, UnsupportedDirectrix]

class DirectrixSegmentMetrics(TypedDict):
    segment_index: int  # index into Directrix
    length: float  # world centreline metres
    bend_angle: Optional[float]  # arc sweep magnitude in radians; None for lines

class DirectrixMetrics(TypedDict):
    total_length: float  # sum of segment centreline lengths in world metres
    segments: List[DirectrixSegmentMetrics]

class SweptDiskOccurrence(TypedDict):
    solid_id: int
    directrix_id: int
    Radius: float  # world radius when complete; authored radius in metres when unsupported
    InnerRadius: Optional[float]  # same coordinate rule as Radius
    Directrix: List[DirectrixSegment]  # IFC Z-up, absolute world metres
    directrix_metrics: Optional[DirectrixMetrics]  # None when status is unsupported
    status: DirectrixStatus
    mapping_path: List[int]
    source_modified: bool  # source operand may differ from final boolean result

class GeometryBuffersWithDirectrices(GeometryBuffers):
    swept_disks: Dict[int, List[SweptDiskOccurrence]]
    directrix_diagnostics: List[str]

SweptDiskFindingCode = Literal[
    "zero_length_segment", "consecutive_gap", "tangent_discontinuity",
    "arc_radius_not_greater_than_disk_radius",
]

class SweptDiskCheckFinding(TypedDict):
    code: SweptDiskFindingCode
    segment_index: int  # index into the source Directrix
    next_segment_index: Optional[int]  # populated for a join between segments
    measured: float
    threshold: float
    units: str  # "m" or "rad"

class SweptDiskCheckReport(TypedDict):
    source_modified: bool  # source sweep may differ from the final CSG result
    skipped_reason: Optional[str]  # unsupported analytic description
    findings: List[SweptDiskCheckFinding]

class SweptDiskCheckEntry(TypedDict):
    occurrence_index: int  # index into this product's swept_disks list
    solid_id: int
    directrix_id: int
    mapping_path: List[int]
    report: SweptDiskCheckReport

class SweptDiskChecks(TypedDict):
    elements: Dict[int, List[SweptDiskCheckEntry]]  # occurrence STEP ID
    diagnostics: List[str]  # representation traversal problems

class AuthoredRebarText(TypedDict):
    kind: Literal["text"]
    value: str

class AuthoredRebarMeasure(TypedDict):
    kind: Literal["measure"]
    value_file_units: float
    value_si: float
    si_unit: Literal["m", "m2"]

class AuthoredRebarAttribute(TypedDict):
    source: Literal["occurrence", "type"]
    source_id: int
    value: Union[AuthoredRebarText, AuthoredRebarMeasure]

class RebarSweep(TypedDict):
    occurrence_index: int
    solid_id: int
    directrix_id: int
    mapping_path: List[int]
    source_modified: bool
    status: DirectrixStatus
    radius_m: float
    inner_radius_m: Optional[float]
    directrix_metrics: Optional[DirectrixMetrics]
    checks: SweptDiskCheckReport

class RebarScheduleRow(TypedDict):
    global_id: Optional[str]
    name: Optional[str]
    type_id: Optional[int]
    authored: Dict[str, AuthoredRebarAttribute]  # exact EXPRESS names
    sweeps: List[RebarSweep]
    geometry_unavailable_reason: Optional[str]
    diagnostics: List[str]

class RebarSchedule(TypedDict):
    units: Literal["m"]
    coordinate_space: Literal["absolute_ifc_world"]
    length_unit_scale: float
    bar_entity_count: int
    represented_sweep_count: int
    rows: Dict[int, RebarScheduleRow]
    diagnostics: List[str]

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
    # Attributes the entity's own IFC class declares (e.g.
    # IfcReinforcingBar.NominalDiameter), named and ordered as the schema
    # declares them. NOT property sets, and unrelated to IfcTypeObject.
    attributes: List[PropValue]

class EntityData(TypedDict):
    length_unit_scale: float  # file length unit -> metres (0.001 for mm files)
    plane_angle_to_radians: float
    project_id: Optional[int]
    entity_count: int
    entities: Dict[int, EntityRow]  # keyed by IFC STEP id, in file order

@overload
def geometry_data_buffers(
    ifc_bytes: bytes,
    quality: Optional[Quality] = None,
    ids: Optional[Set[int]] = None,
    *,
    include_directrices: Literal[True],
) -> GeometryBuffersWithDirectrices: ...

@overload
def geometry_data_buffers(
    ifc_bytes: bytes,
    quality: Optional[Quality] = None,
    ids: Optional[Set[int]] = None,
    *,
    include_directrices: bool = False,
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

    ``ids`` optionally restricts tessellation to those IFC STEP ids. ``None``
    preserves the unfiltered behaviour; an empty set returns no elements, and
    ids absent from the file are ignored. Relationship and representation
    dependencies needed by selected products are still resolved.

    ``include_directrices=True`` adds ``swept_disks`` (keyed by occurrence STEP
    id) and ``directrix_diagnostics``. Each sweep preserves its IFC Radius,
    InnerRadius, ordered analytic line/arc Directrix, and centreline lengths and
    arc bend angles in ``directrix_metrics``. Lengths are world metres and bend
    angles are positive radians; the signed arc ``sweep_angle`` retains travel
    direction. Unsupported sweeps have ``directrix_metrics=None``.

    Raises:
        RuntimeError: the geometry pipeline failed.
        ValueError: ``quality`` is not a recognised label.
    """
    ...

def geometry_data_json(
    ifc_bytes: bytes,
    quality: Optional[Quality] = None,
    ids: Optional[Set[int]] = None,
    *,
    include_directrices: bool = False,
) -> str:
    """Tessellate IFC bytes; return the ``ifc-lite-geometry-data`` JSON document
    as a string (call ``json.loads`` on it).

    Same geometry as :func:`geometry_data_buffers`, but vertices/faces are JSON
    arrays (no numpy needed) and each element also carries ``global_id`` and
    ``name`` when present. ``quality`` and ``ids`` are as documented there.
    ``include_directrices=True`` adds the same swept-disk descriptions with
    JSON object keys for occurrence STEP ids.

    Raises:
        RuntimeError: the geometry pipeline failed.
        ValueError: ``quality`` is not a recognised label, or JSON
            serialization failed.
    """
    ...

def check_swept_disks(
    ifc_bytes: bytes,
    ids: Optional[Set[int]] = None,
    *,
    zero_length_tolerance_m: float = 1e-9,
    gap_tolerance_m: float = 1e-6,
    tangent_tolerance_rad: float = 1e-6,
) -> SweptDiskChecks:
    """Check exact authored swept-disk paths without tessellating.

    Returns reports keyed by occurrence STEP id. Multiple sweeps in an
    occurrence remain separate entries with their source solid, directrix and
    mapped-item path. ``findings`` describe numerical path continuity in
    absolute IFC world metres or radians, not fabrication compliance. A sweep
    whose analytic description is unsupported has ``skipped_reason`` and no
    partial findings. A CSG operand is checked as authored and carries
    ``source_modified=True``; its final post-CSG body may differ.

    ``ids`` filters product occurrences, as in ``geometry_data_buffers``. All
    three tolerances must be finite and nonnegative, including for empty input.

    Raises:
        ValueError: invalid tolerance.
        RuntimeError: extraction worker failed.
    """
    ...

def rebar_schedule(
    ifc_bytes: bytes,
    ids: Optional[Set[int]] = None,
    *,
    zero_length_tolerance_m: float = 1e-9,
    gap_tolerance_m: float = 1e-6,
    tangent_tolerance_rad: float = 1e-6,
) -> RebarSchedule:
    """Return occurrence-keyed rebar metadata and source geometry measurements.

    ``authored`` keys use exact EXPRESS names. Numeric measures carry their raw
    file-unit value and SI conversion; ``directrix_metrics`` is derived from
    geometry in world metres. A row can have zero or several sweeps. Neither
    row nor sweep count is a physical bar count or certified cutting length.
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

    ``quantity_sets`` inherit on exactly the same terms. A type attaches
    ``IfcElementQuantity`` definitions through the same ``HasPropertySets``
    attribute, so they arrive by the same route and merge by the same rule: a
    type quantity set the occurrence does not name is added whole, and a
    same-named one contributes only the quantities the occurrence does not
    already define, so the occurrence wins a collision. One flag governs both
    lists.

    Pass ``type_properties=False`` for own-sets-only, as in 4.3.0, which
    affects ``property_sets`` and ``quantity_sets`` alike.

    Remaining limit, inherited from the shared export model: only
    ``IfcPropertySingleValue`` properties are decoded. Enumerated, list,
    bounded, table and reference properties are skipped silently, and the pset
    still appears with those entries missing.

    ``attributes`` (on by default) returns each entity's SCHEMA-DECLARED IFC
    attributes, which are not property sets and which no amount of pset work
    surfaces. An ``IfcReinforcingBar`` can carry ``SteelGrade``,
    ``NominalDiameter``, ``CrossSectionArea``, ``BarLength``,
    ``PredefinedType``, ``BarSurface`` and ``Tag``; an ``IfcDoor`` can carry
    ``OverallHeight`` / ``OverallWidth``, and so on for every class, named and
    ordered as the schema declares them.

    Only what the file actually sets is returned: an attribute left ``$`` is
    omitted rather than reported empty, so the list is usually shorter than the
    class declares.

    Entries share the ``{name, value, value_type}`` shape of a property, so one
    code path reads both. Fields this dict already carries (``global_id``,
    ``name``, ``description``, ``object_type``) are not repeated, and
    reference-valued attributes are omitted rather than rendered as a dangling
    id.

    Raises:
        RuntimeError: the extraction pipeline failed.
    """
    ...
