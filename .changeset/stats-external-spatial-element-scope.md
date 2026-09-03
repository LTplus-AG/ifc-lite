---
'@ifc-lite/cli': patch
---

`ifc-lite stats`'s `filterBuildingElements` was missing `IfcExternalSpatialElement` (the IFC4/IFC4X3 spatial container for a space boundary outside a building) from its exclusion set, alongside the other `IfcSpatialElement` subtypes (`IfcSpace`, `IfcSpatialZone`) it already excluded. Left in, it never carries a `Name` in normal use, so it would inflate `validation.unnamedElements` the same way the annotation/spatial-container entities this filter was added for did.
