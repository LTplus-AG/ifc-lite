---
"@ifc-lite/lists": minor
"@ifc-lite/parser": minor
"@ifc-lite/viewer": minor
---

Lists can show and filter on the IFC `LongName` attribute, so a room schedule can put each IfcSpace's room name next to its number. The column works for every class that declares `LongName` (IfcSite, IfcBuilding, IfcBuildingStorey, IfcSpace, IfcProject and, from IFC4, IfcZone and the spatial zones and systems) and is empty for classes without it. The "Space Areas" and "Zones & Systems" presets now include it.

`@ifc-lite/lists`: `ENTITY_ATTRIBUTES` gains `LongName`, and `ListDataProvider` gains the optional `getEntityLongName`. `@ifc-lite/parser`: `extractEntityAttributesOnDemand` also returns `longName`, read at the attribute position of the model's own schema.
