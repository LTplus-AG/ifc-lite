---
'@ifc-lite/ifcx': patch
---

An IFCX entity or spatial node with no `Name` (no `bsi::ifc::name`, `prop::Name`, `prop::TypeName`/`prop::ObjectName`, or usable incoming edge name) decoded with a fabricated name: an 8-character slice of its internal IFCX path (e.g. `4f9c1a3e`). That reads as a plausible short name or code no source data backs, indistinguishable from an authored one, and it pre-empted the viewer's own "Name absent" fallback (`getName(id) || '<Type> #<id>'` in the entity tree, `<Type>` alone in the hierarchy panel) since that only fires on a falsy name. Both extractors (`entity-extractor.ts`'s `EntityTable.name`, `hierarchy-builder.ts`'s `SpatialNode.name`) now leave the name `''` when the source genuinely has none, matching the STEP parser's own convention and letting the existing UI fallback show a clearly-synthetic placeholder instead.
