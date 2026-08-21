---
"@ifc-lite/query": major
---

**Breaking:** `IfcQuery.ofType()` now throws for a type string that is not an IFC entity name, instead of silently querying the `Unknown` bucket.

`ofType()` maps each type string through `IfcTypeEnumFromString`, which falls back to `IfcTypeEnum.Unknown` for any name it does not recognize. A typo — `ofType('IfcWal')` — therefore returned every entity whose type the store could not classify: neither the caller's walls nor an empty result, but some other, unrelated set of entities. `ofType()` now rejects such a string with an error naming it.

What still works unchanged:

- **Standard IFC types that this build's enum table does not map.** `TYPE_STRING_TO_ENUM` (`@ifc-lite/data`) is a curated subset of IFC, so standard buildingSMART types such as `IfcChiller`, `IfcActuator`, `IfcElectricAppliance`, `IfcBuildingSystem` and `IfcAudioVisualAppliance` also resolve to `Unknown`. These are **not** rejected — they keep falling through to the `Unknown` bucket exactly as before, which is the only representation this build has for them and which answers the query correctly in a file whose unclassified entities are of that type. The check is keyed on `IFC_ENTITY_NAMES`, the full IFC4X3 entity-name table, not on whether the enum table happened to have a row.
- **The `Unknown` bucket itself**, still reachable by passing the literal string `'Unknown'`.

What breaks: a call passing a name that is not an IFC entity name at all — a typo, or a genuine vendor-specific type name — previously returned an `EntityQuery` over the `Unknown` bucket and now throws. Callers relying on a vendor-specific name to reach unclassified entities must pass `'Unknown'` instead. Hence the major bump: this is a behaviour change on a published SDK export, not a bug fix that is invisible to correct callers.
