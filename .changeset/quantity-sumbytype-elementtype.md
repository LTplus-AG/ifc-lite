---
"@ifc-lite/data": patch
"@ifc-lite/cache": patch
---

Stop `QuantityTable.sumByType` from silently ignoring its declared `elementType` filter.

`sumByType(quantityName, elementType?)` declares an optional element-type filter, but two of the three implementations were arity-1 closures that dropped it: the columnar table in `@ifc-lite/data` and the cache-restored table in `@ifc-lite/cache`. The third — the server-backed table in `apps/viewer` — honours it for real, resolving ids through `entities.getByType`. So three implementations of one interface disagreed, and a caller holding the interface type had no way to tell which behaviour it would get.

The failure mode mattered more than the type-level inaccuracy: a dropped filter returns a total over *every* element rather than an error, and in a quantity context a plausible wrong number is worse than a loud failure. No caller passes the second argument today, so nothing changes for existing code.

Neither implementation can honour the filter as written — both see only `entityId` per row, with the entity-type mapping living in `EntityTable`. Rather than leave the contract lying, both now throw when `elementType` is passed, naming the supported route (resolve ids via `entities.getByType(elementType)` and total the matching rows). The interface doc records why.
