---
"@ifc-lite/create": patch
---

`IfcCreator.addIfcSpace` now aggregates the space under its storey with `IfcRelAggregates` instead of listing it in the storey's `IfcRelContainedInSpatialStructure`, which `IfcRelContainedInSpatialStructure.WR31` and `IfcSpatialStructureElement.WR41` reject (IFC2X3, IFC4 and IFC4X3). This matches what the in-store `addSpaceToStore` already wrote. An `IFCSPACE` made through the generic `addElement` or `addAxisElement` is aggregated the same way.
