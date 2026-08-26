---
'@ifc-lite/ifcx': patch
---

IFCX export writes each entity's own IFC class, and the IFCX spatial tree keeps its IFC4.3 facility levels.

The writer mapped an entity's `typeEnum` to the `bsi::ifc::class` code through a 26-row table written out by hand. `IfcTypeEnum` has 128 members and its numbering had moved on since the table was typed, so the table was both incomplete and shifted against the enum it claimed to decode: 14 of its 26 rows named a different class than the id actually holds. An `IfcStair` was exported as `IfcRoof`, an `IfcMember` as `IfcPile`, an `IfcDistributionElement` as `IfcOpeningElement` — a wrong class written into the file, not a display glitch — and the 102 ids with no row at all (every MEP, infrastructure and furniture class) lost their class attribute entirely. The synthesized `ifc:<Type>.<expressId>` path of a GlobalId-less entity carried the same wrong name. The class now comes from the entity table, which resolves an override, then the enum, then the raw parsed class name — so `IfcAirTerminal`, which the enum does not carry, also keeps its own name.

Separately, the set deciding which classes are *levels* of the IFCX spatial tree listed the five building-storey levels and none of IFC4.3's twelve. Because the same set is the stop condition for element collection, an infrastructure model's `IfcRoad` / `IfcRoadPart` were not merely missing from the tree — they and everything beneath them were flattened into the site's element list, and an `IfcSite -> IfcRoad` edge was reported as containment rather than aggregation. Both call sites now read `SPATIAL_STRUCTURE_TYPE_ENUMS` from `@ifc-lite/data`, the same answer the parser and the viewer's hierarchy already use.
