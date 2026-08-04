---
"@ifc-lite/export": patch
---

STEP export: keep georeferencing edits when the session deleted the file's existing georeferencing.

The exporter looked up `IfcProjectedCRS` / `IfcMapConversion` in the raw entity index, so a CRS the session had deleted still counted as "existing". The edit was queued against the deleted entity, the export skipped that entity, and the replacement georeferencing vanished from the output with no error. The lookup now goes through the effective (overlay-aware) index, so a deleted CRS or map conversion is recreated instead.

The same index now backs the source-CRS context and length-unit lookups the georef path uses, so newly created georeferencing can no longer reference a deleted context or unit.
