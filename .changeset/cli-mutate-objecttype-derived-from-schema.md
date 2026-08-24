---
"@ifc-lite/cli": patch
---

`ifc-lite mutate --set ObjectType=...` refused 189 of the 218 IFC4 entity types that actually have an ObjectType attribute.

The command guarded the write with a hand-written list of 29 type names. Every name in it was correct, but the list had never kept up with the schema, so setting ObjectType on an `IfcFurniture`, `IfcStairFlight`, `IfcPipeSegment`, `IfcSanitaryTerminal` — or any of 185 others — printed `Warning: attribute "ObjectType" not applicable to IFCFURNITURE #7, skipping` and silently wrote nothing. The warning was simply wrong: those entities do define ObjectType.

The set is now read from the bundled buildingSMART schema for the file's own schema version, so it cannot fall behind again, and it distinguishes IFC2X3 from IFC4 rather than being schema-blind as the old list was. A version with no bundled attribute table (`IFC5`, which the exporter accepts) falls back to IFC4 instead of throwing.

The guard still does real work — this is not "write it anywhere". `IfcRelAggregates`, `IfcWallType` and `IfcPropertySet` have no ObjectType slot, so attribute index 4 on those lines is a different attribute entirely and writing to it would corrupt the file; those are still refused, and a test now pins both directions.

Also covered for the first time: that `Name`, `Description` and `ObjectType` land in STEP attribute slots 2, 3 and 4 respectively. This writer edits STEP text by position, so an off-by-one there rewrites a neighbouring attribute rather than failing, and nothing asserted it before.
