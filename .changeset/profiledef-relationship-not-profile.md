---
"@ifc-lite/ids": patch
---

Fix `isNonRootedClassifiableResource` (`packages/ids/src/bridge/classifications.ts`) treating `IfcRelAssociatesProfileDef` (an IFC4X3 entity) as a possible `RelatedResourceObjects` target of an `IfcExternalReferenceRelationship`, because its name contains "PROFILEDEF". It is `SUBTYPE OF (IfcRelAssociates)` — a rooted relationship that POINTS AT a profile def via its own `RelatingProfileDef` attribute, not an `IfcProfileDef` itself — so a genuinely unclassified one was reported `CLASSIFICATION_UNRESOLVED` (presence cannot be determined) instead of the correct `CLASSIFICATION_MISSING`, on a server-parsed (source-empty) store. Excluded any type name starting with `IFCREL`, which every genuine `IfcProfileDef` descendant's name never does.
