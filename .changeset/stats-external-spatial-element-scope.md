---
'@ifc-lite/cli': patch
---

`ifc-lite stats`'s `filterBuildingElements` was missing `IfcExternalSpatialElement` (the IFC4/IFC4X3 spatial container for a space boundary outside a building) from its exclusion set, alongside the other `IfcSpatialElement` subtypes (`IfcSpace`, `IfcSpatialZone`) it already excluded. Left in, it never carries a `Name` in normal use, so it would inflate `validation.unnamedElements` the same way the annotation/spatial-container entities this filter was added for did.

The rest of that exclusion set was a hand-written copy of the spatial-structure type list and had already drifted from `@ifc-lite/data`'s `isSpatialStructureTypeName`, the repo's single authority for it: it named `IfcFacilityPart`/`IfcBridgePart`/`IfcRoadPart`/`IfcRailwayPart` but not their IFC4X3 siblings `IfcFacilityPartCommon` and `IfcMarinePart`, so an unnamed instance of either still counted as an unnamed building element. `filterBuildingElements` now asks that authority instead of restating the list, and only names what the authority deliberately does not cover (`IfcExternalSpatialElement`, the grouping classes, `IfcAnnotation`).
