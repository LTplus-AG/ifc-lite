---
"@ifc-lite/cli": patch
---

Fix `extract-entities` losing spatial containment for products under an `IfcSpace`, `IfcSpatialZone`, or an IFC4X3 facility class, and force-keeping every unrelated `IfcBuildingStorey` as a context root. Context roots are now the backward closure of the selection's actual spatial ancestors instead of a hardcoded `IfcProject`/`IfcSite`/`IfcBuilding`/`IfcBuildingStorey` type list.
