---
'@ifc-lite/viewer': patch
---

The command palette's `Export JSON` entry now names each entity's declared class instead of its `IfcTypeEnum`-coalesced family (#3503). `#3475` routed the Lists Class column and the Parquet `Type` column onto `@ifc-lite/data`'s `exactTypeName()`; the palette's `export:json` action was a third, independent caller still reading `EntityTable.getTypeName` directly, so exporting the same model via the palette named `IFCDOORSTANDARDCASE` entities `IfcDoor` while the other two export paths named them `IfcDoorStandardCase`. The row-building logic is extracted to `buildCommandPaletteJsonEntities` (`apps/viewer/src/components/viewer/commandPaletteJsonExport.ts`) so all three export paths now route through the same accessor.
