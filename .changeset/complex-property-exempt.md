---
"@ifc-lite/export": patch
---

Fix an anonymized subset export over-scrubbing `IfcComplexProperty`'s `Name`. `isNonRootNameExempt`'s `startsWith('IFCPROPERTY')` check exempts `IfcProperty` subtypes' names from pseudonymization (so property/quantity names stay legible under `keepPropertySets`), but `IfcComplexProperty` is a direct `IfcProperty` subtype in both IFC4 and IFC4X3 whose own name doesn't start with `IFCPROPERTY`, so it fell through to the sweep and got pseudonymized instead of exempted. This is an over-scrub (a debuggability loss), not a data leak — the direction is the opposite: the export was more anonymized than intended.

Fixed with an explicit exact-type check rather than widening the string prefix, to avoid reintroducing the same defect shape at a different edge; pinned with a test that derives the answer from the EXPRESS schemas directly. Should be converted to a proper `isSubtypeOf` schema-hierarchy check once `@ifc-lite/codegen`'s exported schema hierarchy (#4041) lands.

Also tightens `anonymize-scrub.test.ts`'s "control: a type that should still be scrubbed" test, which used `IfcPropertySet` — an `IfcRoot`, so `slotsFor` never reaches `isNonRootNameExempt` for it at all (it short-circuits on `IFC_ROOT_TYPES` first) — and stayed green even when `isNonRootNameExempt` was mutated to `return true` unconditionally. The control now pins a non-root `IfcMaterial`, whose `Name` genuinely depends on `isNonRootNameExempt`'s answer.
