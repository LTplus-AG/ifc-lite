---
"@ifc-lite/ids": minor
"@ifc-lite/rules": patch
---

An IDS `partOf` facet without a `relation` now counts every partOf relation, followed recursively, as the IDS 1.0 user manual says (#7401). It used to be read as `IfcRelContainedInSpatialStructure`, so a mullion aggregated into a curtain wall failed `<partOf><entity>IFCCURTAINWALL</entity></partOf>`, the manual's own example. A chain may now mix relations: a window that fills an opening in a wall contained in a storey is partOf that storey. A `partOf` that names a relation is unchanged.

- `IDSPartOfFacet.relation` is now optional: absent means the IDS gave no relation. Code that reads it should treat `undefined` as "any relation".
- `IFCDataAccessor.getParent` and `getAncestors` accept `undefined` for the relation, meaning every partOf relation. The bridge's accessor walks all of them.
- The audit no longer reports `E_IFC_PARTOF_ENTITY` for a partOf without a relation whose entity fits any relation (an `IfcCurtainWall`, say). It still reports one that fits none, naming "any partOf relation".
- Messages for such a facet say "part of" (de "Teil von", fr "rattaché à") instead of "contained in".
- `@ifc-lite/rules`: `writeIdsXml` writes a partOf without a relation without one, so it reads back the same.
