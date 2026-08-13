---
"@ifc-lite/create": minor
---

Add `addSpatialZonesToStore`, an anchored builder for `IfcSpatialZone`.

A location zone (a takt area, a construction section) is emitted as
`IfcSpatialZone` rather than `IfcZone`: that type groups spaces, so assigning
walls to one produces a file most readers, this one included, mis-read. Elements
attach through `IfcRelReferencedInSpatialStructure`, which is many-to-many and
additive, so emitting zones never re-parents anything and an element straddling
two zones can belong to both.

Boxes emit an `IfcRectangleProfileDef` with any rotation carried in the
placement; a convex footprint emits the polygon instead. `spatialZonesSupported`
reports whether the target schema has the type at all, since IFC2X3 does not.
