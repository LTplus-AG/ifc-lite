---
'@ifc-lite/ifcx': patch
---

Fix `extractEntities` dropping entity descriptions (`EntityTable.description`, read via `entities.getDescription(id)`) when reading an IFCX archive.

`IfcxWriter` writes `EntityTable.description` out as `bsi::ifc::prop::Description`, alongside the name it writes as `bsi::ifc::prop::Name` (see its "IFC5 uses bsi::ifc::prop:: namespace for name/description" comment). `entity-extractor.ts`'s `extractEntities` read `bsi::ifc::prop::Name` back via `extractName`, but hardcoded `description` to `''` for every entity instead of reading `bsi::ifc::prop::Description` back the same way — so an entity's description survived nowhere on a round trip through an IFCX archive (write, then read back), even though the writer faithfully emitted it.

`extractEntities` now reads `bsi::ifc::prop::Description` via a new `extractDescription`, mirroring `extractName`'s direct-attribute lookup (with no incoming-edge-name fallback, since an edge name is a plausible stand-in for a missing name but not for a missing description).
