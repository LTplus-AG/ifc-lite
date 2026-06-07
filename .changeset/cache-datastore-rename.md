---
"@ifc-lite/cache": major
---

Rename the serialized data-store type `IfcDataStore` → `CacheDataStore`.

This removes the name collision with `@ifc-lite/parser`'s runtime `IfcDataStore` — the two are structurally different (the cache type is the on-disk/serialized shape, keyed on a numeric `schema` enum, with no `source`/`parseTime`/accessors). Consumers importing the type from `@ifc-lite/cache` must switch `IfcDataStore` → `CacheDataStore`.
