---
"@ifc-lite/codegen": minor
"@ifc-lite/ids": patch
"@ifc-lite/export": patch
---

Export `@ifc-lite/codegen`'s generated schema hierarchy so type-membership questions ("is this entity a subtype of X?") can be answered from the actual EXPRESS `SUBTYPE OF` chain instead of a string test on the type name.

`@ifc-lite/codegen` now ships its generated `ifc4` and `ifc4x3` bundles (`SCHEMA_REGISTRY`, entity/type/enum/select interfaces, serializers) as `@ifc-lite/codegen/ifc4` and `@ifc-lite/codegen/ifc4x3` subpath exports, and adds `isSubtypeOf` / `isSubtypeOfAny` / `isProperSubtypeOf` / `isProperSubtypeOfAny` helpers built on each bundle's `inheritanceChain`.

`@ifc-lite/ids`'s `isNonRootedClassifiableResourceType` (deciding whether an entity can carry classifications via `IfcExternalReferenceRelationship`) and `@ifc-lite/export`'s LOD0 generator (excluding materials from candidate elements) now use these helpers instead of pinned `startsWith`/`endsWith`/`includes` string tests on the type name — the pattern behind three separate one-string-test-wrong-at-a-different-edge incidents in as many days.
