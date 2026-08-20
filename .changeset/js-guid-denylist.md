---
"@ifc-lite/export": patch
---

Fix the merged STEP exporter mistaking a non-rooted entity's leading string
attribute for a GlobalId.

`MergedExporter.extractGlobalIdFast` identifies a rooted entity's GlobalId
positionally (first quoted attribute, 22 charset characters), then relied on a
hand-maintained denylist of non-rooted types known to lead with a
Name/Identifier string, so their string was never mistaken for a GlobalId. The
denylist was incomplete — `IfcMaterialProfileWithOffsets` and several other
`IfcMaterialDefinition`/resource types were missing — so a merge could
misidentify such an entity's Name as a GlobalId. On a coincidental collision
with a real GlobalId, the entity was silently unified away (or re-stamped),
corrupting ordinary model data.

Replaced the denylist with a schema-derived positive check:
`getInheritanceChainAcrossSchemas(type).includes('IfcRoot')`, mirroring the
Rust exporter's `IfcType::is_subtype_of(IfcRoot)`. This cannot go stale as the
schema grows, and the two exporters now agree on what "rooted" means instead
of keeping two hand-maintained answers to the same question.
