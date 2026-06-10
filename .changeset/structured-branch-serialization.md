---
'@ifc-lite/collab': minor
'@ifc-lite/ifcx': minor
---

Serialize structured entity branches (psets, quantities, classifications, materials, geometryRef) through the IFCX snapshot pipeline (#1031): `snapshotToIfcx` folds them into namespaced attributes (`bsi::ifc::v5a::<Set>::<Name>` for psets/quantities, `ifclite::` carriers for the rest), `seedFromIfcx` re-inflates them, and `extractMinimalLayer` diffs the same flattened view so structured edits and deletions survive snapshot → seed round-trips and minimal layers.
