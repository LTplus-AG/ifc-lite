---
'@ifc-lite/clash': patch
---

Stop treating spatial containers as clash bodies in the STEP adapter.

`NON_CLASHABLE_TAGS` dropped `IfcSpace` and `IfcSpatialZone` (#1464) but nothing else from the spatial structure, so any container that carries tessellated geometry became a clash body and collided with the elements assigned to it. That is not a coordination problem — a storey's geometry is its extent, and by construction it encloses its contents.

It bites hardest on IFC4.3 infrastructure models, where storeys and facility parts routinely carry real bodies. On one road/bridge certification model a default `ifc-lite clash` run reported 235 clashes, of which 89 (37.9%) were an `IfcBuildingStorey` against an element it contains.

The check is now derived from the schema instead of enumerated: an element is dropped when `getInheritanceChainAcrossSchemas` puts `IfcSpatialElement` or `IfcSpatialStructureElement` in its chain. That walks the bundled IFC2X3 + IFC4 + IFC4X3 union, so `IfcSite`, `IfcBuilding`, `IfcBuildingStorey`, `IfcExternalSpatialElement` and the IFC4.3 facility leaves (`IfcFacility`, `IfcFacilityPart`, `IfcBridge`, `IfcRoad`, `IfcRailway`, `IfcMarineFacility`, …) are all covered without a second hand-maintained list, and `IfcSpatialStructureElement` is checked alongside `IfcSpatialElement` because IFC2X3 has no `IfcSpatialElement`. The two hand-listed space entries are removed as redundant.

Elements *contained in* a container are unaffected — they still clash with each other, and still carry the storey name as metadata. Measured on the road/bridge model: 235 → 146 clashes, 89 pairs removed and none added, every removed pair involving `IfcBuildingStorey`. Building-model controls: 274 → 274 and 469 → 469 with byte-identical pair sets; 282 → 279 on a third, the three removed pairs all being the site's own terrain body.

No API surface change.
