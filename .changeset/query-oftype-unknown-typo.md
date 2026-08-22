---
"@ifc-lite/query": major
"@ifc-lite/parser": patch
"@ifc-lite/codegen": patch
---

**Breaking:** `IfcQuery.ofType()` now throws for a type string that is not an IFC entity name, instead of silently querying the `Unknown` bucket.

`ofType()` maps each type string through `IfcTypeEnumFromString`, which falls back to `IfcTypeEnum.Unknown` for any name it does not recognize. A typo — `ofType('IfcWal')` — therefore returned every entity whose type the store could not classify: neither the caller's walls nor an empty result, but some other, unrelated set of entities. `ofType()` now rejects such a string with an error naming it.

What still works unchanged:

- **Standard IFC types that this build's enum table does not map.** `TYPE_STRING_TO_ENUM` (`@ifc-lite/data`) is a curated subset of IFC, so standard buildingSMART types such as `IfcChiller`, `IfcActuator`, `IfcElectricAppliance` — and IFC2X3's `IfcDoorStyle`, `IfcWindowStyle` and `IfcElectricalDistributionPoint` — resolve to `Unknown`. These are **not** rejected: they keep falling through to the `Unknown` bucket exactly as before, which is the only representation this build has for them and which answers the query correctly in a file whose unclassified entities are of that type.

  The oracle deciding this is `isKnownType()` (`@ifc-lite/parser`), the predicate that already guards `@ifc-lite/sdk`'s `addEntity`: the bundled **IFC2X3 + IFC4 + IFC4X3** schema union, minus EXPRESS defined types (`IfcLengthMeasure`, `IfcArcIndex`), with the IFC4_ADD2_TC1 codegen pin as a fallback, plus the parser's alias table for IFC2X3 leaves the bundled EXPRESS exports omit. Reusing it rather than adding a second name table keeps one source of truth for "is this a real IFC class". The suite asserts the coverage exhaustively — every entity in `SCHEMA_REGISTRY` and in all three per-version tables must pass `ofType()` — rather than by sampling names.
- **The `Unknown` bucket itself**, still reachable by passing the literal string `'Unknown'`.

Also fixed, in `@ifc-lite/parser`'s generated schema registry and the `@ifc-lite/codegen` template that emits it: `isKnownEntity()` asked `name in SCHEMA_REGISTRY.entities`, and `in` walks the prototype chain, so every `Object.prototype` member name — `constructor`, `toString`, `valueOf`, `hasOwnProperty`, `isPrototypeOf`, `__proto__` — answered `true`. That reached `isKnownType()`, so `ofType('constructor')` passed the guard and returned the `Unknown` bucket, and `@ifc-lite/sdk`'s `addEntity` accepted the same names as IFC classes. `getEntityMetadata()` indexed the same object literal and returned `Object.prototype.toString` typed as `EntityMetadata`. Both now use `Object.hasOwn`, fixed in the generator so a regeneration cannot bring it back.

What breaks: a call passing a name that is not an IFC entity name in any of those schemas — a typo, or a genuine vendor-specific type name — previously returned an `EntityQuery` over the `Unknown` bucket and now throws. Callers relying on a vendor-specific name to reach unclassified entities must pass `'Unknown'` instead. Hence the major bump: this is a behaviour change on a published SDK export, not a bug fix that is invisible to correct callers.

The error text says which schemas were searched rather than assuming a misspelling, because a rejected name may well be spelled correctly:

> `ofType(): "IfcWal" is not an entity name in any IFC schema this build reads (IFC2X3, IFC4, IFC4X3). Check the spelling; for a vendor-specific type name, pass 'Unknown' to query entities whose type could not be classified.`
