---
"@ifc-lite/export": patch
---

Fix `ParquetExporter.writeEntities()` writing an overlay-retyped entity's PRE-retype class into `Entities.parquet`'s `Type` column. `writeEntities` already consults the overlay (`MutablePropertyView`) to drop tombstoned rows, but read `Type` straight off the parsed `entities.typeEnum` array regardless, never asking the same `EffectiveEntityIndex` its `isDeleted` check already uses. `StepExporter`/`Ifc5Exporter` resolve `effective.typeOf(id)` before emitting an entity's class, so a `setEntityType` retype (e.g. reclassifying a wall as a column) changed what those two exporters wrote but silently left the `.bos` archive's `Entities.parquet` naming the entity's original class — disagreeing with every other export of the same overlay.

Rows that were not retyped are unaffected, byte for byte: the overlay's class is only used where it actually disagrees with the parsed one. That distinction matters because `typeOf` answers for every indexed entity (not just retyped ones) and answers uppercase, so sourcing the whole column from it would have re-rendered untouched rows through a name table that is missing four of the 125 enum types — turning `IfcProxy`, `IfcSolidStratum`, `IfcVoidStratum` and `IfcWaterStratum` rows uppercase.
