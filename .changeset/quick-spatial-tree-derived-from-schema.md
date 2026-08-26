---
'@ifc-lite/wasm': patch
'@ifc-lite/server-client': patch
---

Derive the fast-boot spatial tree's type gate from the generated schema instead of a hand-written list of fourteen names.

`is_quick_spatial_type_ci` decides which entities become nodes in the bootstrap
spatial tree — the hierarchy the viewer shows while a file is still loading. It
hand-listed fourteen entity names, and a hand list is only ever as complete as
whoever last audited the schema. It was missing `IfcMarineFacility`,
`IfcMarinePart` and `IfcFacilityPartCommon`, so an IFC4.3 harbour or a generic
facility with common parts lost its whole branch from that tree: the facility
was never inserted as a node, so nothing aggregated beneath it could be
reparented either.

The gate now asks `ifc_lite_core::IfcType` directly — `IfcProject`, plus
`IfcSpatialZone`, plus the whole `IfcSpatialStructureElement` closure — the same
move `rooted_type.rs` made for `IfcRoot`. Newly recognised as fast-boot spatial
nodes: `IfcMarineFacility`, `IfcMarinePart`, `IfcFacilityPartCommon` and
`IfcSpatialStructureElement` itself. Nothing previously recognised is dropped.

`IfcExternalSpatialElement` stays out on purpose. It is an `IfcSpatialElement`,
but it descends from `IfcExternalSpatialStructureElement`, carries none of the
`WR41` aggregation rule that defines the containment hierarchy, and models a
space *boundary* volume rather than a container — admitting it would put a
permanently parentless node in the tree.
