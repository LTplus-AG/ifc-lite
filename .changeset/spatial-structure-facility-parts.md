---
"@ifc-lite/data": minor
---

Recognise `IfcMarinePart` and `IfcFacilityPartCommon` as spatial structure elements.

`SPATIAL_STRUCTURE_TYPE_ENUMS` is the single source of truth for "does this entity belong in the spatial tree". It listed twelve of the fourteen concrete `IfcSpatialStructureElement` subtypes IFC4X3 defines: `IfcMarineFacility` was there but its part type was not, and the generic `IfcFacilityPartCommon` was missing too. `IfcTypeEnum` had no member for either, so `EntityTable.getTypeEnum` answered `Unknown` for them and `isSpatialStructureType` answered `false`.

`SpatialHierarchyBuilder.addSpatialChild` only recurses into a child that `isSpatialStructureType` accepts, so an `IfcMarinePart` or `IfcFacilityPartCommon` aggregated under its facility produced no node at all — the part and every element it contained were absent from the spatial hierarchy, and therefore from the viewer's Hierarchy panel, while the sibling `IfcRoadPart` / `IfcBridgePart` / `IfcRailwayPart` rows appeared normally. A port or quay model built out of `IfcMarinePart` berths showed an empty facility.

Both types now have an `IfcTypeEnum` member with entries in the STEP-name and display-name maps, and both join `SPATIAL_STRUCTURE_TYPE_ENUMS`. The new enum ids are additive (321, 322); no existing id moves.

`spatial-types.test.ts` no longer re-types the entity names by hand. It derives the expectation from `ENTITIES_IFC4X3` — the table generated from buildingSMART's own `SchemaInfo.*.g.cs` — walking the `parent` chain for every non-abstract `IfcSpatialStructureElement` descendant, and asserts in both directions: every such entity is recognised by name AND resolves through the STEP-name map, and nothing in the list is an entity the schema does not call spatial (`IfcProject`, the tree root, and `IfcSpatialZone`, an `IfcSpatialElement` carried deliberately since #1075, are the documented exceptions). An anti-vacuity assertion pins the derived list so a broken traversal cannot pass over an empty set.
