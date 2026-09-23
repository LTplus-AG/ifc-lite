---
"@ifc-lite/parser": patch
"@ifc-lite/ids": patch
---

Fix a broken classification chain (a dangling `ReferencedSource`, an unreadable entity, an entity of an unexpected type, or a cycle) reporting a confident `CLASSIFICATION_SYSTEM_MISMATCH` instead of `CLASSIFICATION_UNRESOLVED`. `walkClassificationChain` (`@ifc-lite/parser`) and the structurally identical `IfcExternalReferenceRelationship` walk in `@ifc-lite/ids`'s `resolveClassifications` both stopped without reporting anything when the chain could not be followed to an `IfcClassification` root, leaving `system` `undefined` — indistinguishable from a chain that legitimately ends without naming one (`ReferencedSource` omitted, which is schema-legal). Both walks now mark the classification record `unresolved` when the chain genuinely could not be resolved, so the IDS classification facet reports `CLASSIFICATION_UNRESOLVED` (the same fail-closed path #3948 already established) instead of asserting a system mismatch the data never proved.
