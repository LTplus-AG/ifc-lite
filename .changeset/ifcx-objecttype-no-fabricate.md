---
'@ifc-lite/ifcx': patch
---

Fix `extractEntities` fabricating `ObjectType` from the IFC class code for every entity read from an IFCX archive — `entities.getObjectType(id)` for an entity of class `IfcWall` returned the string `'IfcWall'` no matter what the source said. Any consumer of `ObjectType` (CSV/Parquet export, the query engine's `ObjectType` column, IDS's `getObjectType`, the lens summary line) saw that invented value, indistinguishable from a real authored one.

`extractEntities` now reads `ObjectType` from the node's `bsi::ifc::prop::ObjectType` attribute, mirroring how it reads `bsi::ifc::prop::Name` and `bsi::ifc::prop::Description`, and falls back to `''` when the node carries no such attribute — the same default the STEP parser uses for an entity with no `ObjectType` value. buildingSMART's official v5a `prop` schema defines no `ObjectType`, so a third-party IFCX archive usually leaves the field empty; ifc-lite's own collaboration seed does write the key, and it now survives the snapshot round trip instead of being overwritten with the class code.
