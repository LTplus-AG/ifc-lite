---
"@ifc-lite/ids": patch
---

`isNonRootedClassifiableResource` (`packages/ids/src/bridge/classifications.ts`) decided whether an entity type could be a `RelatedResourceObjects` target of an `IfcExternalReferenceRelationship` — used to determine when a server-parsed (source-empty) store should report `CLASSIFICATION_UNRESOLVED` rather than `CLASSIFICATION_MISSING`. Its `IfcProfileDef` half was a substring test (`includes('PROFILEDEF')` excluding an `IFCREL` prefix), the third string-matching predicate in this spot in three days, each wrong at a different edge (`startsWith('IFCMATERIAL')` over-matched; `endsWith('PROFILEDEF')` missed `IfcArbitraryProfileDefWithVoids`; `includes('PROFILEDEF')` over-matched `IfcRelAssociatesProfileDef`, patched ad hoc).

Replaced the substring test with an explicit `PROFILE_DEF_TYPES` set (mirroring the existing `MATERIAL_DEFINITION_TYPES`), derived by walking every `SUBTYPE OF` chain in both `packages/codegen/schemas/IFC4_ADD2_TC1.exp` and `IFC4X3.exp` down to `IfcProfileDef`. Added `is-non-rooted-classifiable-resource.exp-derived.test.ts`, which re-derives the same answer directly from both `.exp` files at test time and asserts it against the code's answer for every entity name in both schemas, plus the exact entities each of the three historical bugs got wrong — so a future schema addition or a hand-edit to either set is checked against the schema itself, not just against today's fixtures.

No behavior change for any entity type recognized before this patch; extends coverage to `IfcOpenCrossProfileDef` (IFC4X3-only).
