---
"@ifc-lite/ids": patch
---

Fix an IDS entity facet naming an IFC4-only class (`IfcAirTerminal`, `IfcFilter`, `IfcValve`, …) never matching anything in an IFC2X3 model.

IFC2X3 predates those classes; the same concept there is a generic occurrence class (`IfcFlowTerminal`, `IfcFlowTreatmentDevice`, `IfcFlowController`, …) related to a specific type object (`IfcAirTerminalType`, `IfcFilterType`, `IfcValveType`, …) via `IfcRelDefinesByType`. buildingSMART's IDS spec defines an occurrence/type mapping table so a facet naming the IFC4-only class still matches the equivalent IFC2X3 pair ("the definition of an IDS applicability facet with entity `IfcFilter`, should result in the identification of all `IfcFlowTreatmentDevice` that are associated with a type `IfcFilterType`") — this package implemented no such mapping, so every entity facet using one of the table's 55 aliases against an IFC2X3 model reported zero applicable entities regardless of content. `packages/ids/src/facets/ifc2x3-type-mapping.ts` now carries the table (scoped to IFC2X3 only — IFC4+ already has a dedicated class for every alias), consulted by `checkEntityFacet`, `entityFacetPasses` and the applicability broadphase filter.

Also fix a property facet applied directly to `IfcMaterial` always reporting the property set missing. `IfcMaterialProperties` (IFC4+) / `IfcExtendedMaterialProperties` (IFC2X3) attach property sets straight to the material, not through `IfcRelDefinesByProperties` like every other pset, and `collectAllPropertySets` never read them.

Found via buildingSMART's official IDS conformance corpus (16 test cases added upstream since this repository's #1685 vendoring, re-synced here): all 6 `pass-` cases covering these two gaps previously failed.
