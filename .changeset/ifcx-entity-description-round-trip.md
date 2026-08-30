---
'@ifc-lite/ifcx': patch
---

Fix `extractEntities` dropping `IfcEntity.description` when reading an IFCX archive.

`IfcxWriter`'s `writeEntities` writes `EntityTable.description` out to the same `bsi::ifc::prop::Description` attribute it writes `.name` to under `bsi::ifc::prop::Name` (see its "IFC5 uses bsi::ifc::prop:: namespace for name/description" comment). `entity-extractor.ts`'s `extractEntities` read `bsi::ifc::prop::Name` back via `extractName`, but hardcoded `description` to `''` for every entity instead of reading `bsi::ifc::prop::Description` back the same way — so an entity's description survived nowhere on a round trip through an IFCX archive (write, then read back), even though the writer faithfully emitted it.

`extractEntities` now reads `bsi::ifc::prop::Description` via a new `extractDescription`, mirroring `extractName`'s direct-attribute lookup (with no incoming-edge-name fallback, since an edge name is a plausible stand-in for a missing name but not for a missing description).
