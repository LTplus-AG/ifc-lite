---
"@ifc-lite/query": patch
---

Fix `IfcQuery.ofType()` silently matching unrelated entities for a misspelled or unrecognized IFC type name.

`ofType()` mapped each type string through `IfcTypeEnumFromString`, which falls back to `IfcTypeEnum.Unknown` for any name it does not recognize. A typo (`ofType('IfcWal')`) or a vendor-specific type name therefore queried the `Unknown` bucket instead of returning nothing — every entity whose type the store itself could not classify, which is neither the caller's intended type nor an empty result, but some other, unrelated set of entities. `ofType()` now throws for an unrecognized type name; the `Unknown` bucket itself is still reachable by passing the literal string `'Unknown'`.
