---
'@ifc-lite/collab': minor
'@ifc-lite/ifcx': minor
'@ifc-lite/mcp': minor
---

Serialize structured entity branches (psets, quantities, classifications, materials, geometryRef) through the IFCX snapshot pipeline (#1031): `snapshotToIfcx` folds them into namespaced attributes (`bsi::ifc::v5a::<Set>::<Name>` for psets/quantities, `ifclite::` carriers for the rest), `seedFromIfcx` re-inflates them, and `extractMinimalLayer` diffs the same flattened view so structured edits and deletions survive snapshot → seed round-trips and minimal layers. The typed `TypedPropertyValue` record is the canonical wire shape: the MCP `set_property` draft op emits it, property extraction decodes it (and skips `ifclite::` carriers), composition resolves `null` attribute opinions as removals, and `bakeLayers` preserves the persistent carriers while stripping bookkeeping.
