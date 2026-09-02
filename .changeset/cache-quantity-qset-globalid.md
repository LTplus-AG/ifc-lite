---
'@ifc-lite/cache': patch
---

Persist the new `QuantityTable.qsetGlobalId` column through the binary cache format and restore the same distinct-instance grouping in `readQuantities`'s `getForEntity`, mirroring `properties.ts`'s `psetGlobalId` handling. Bumps `FORMAT_VERSION` from 16 to 17 (a wire-format-breaking column addition); `FORMAT_VERSION` is embedded in the cache key, so old-format entries simply never key a hit — no read-side migration.

Both `getForEntity` implementations -- the columnar one in `@ifc-lite/data`'s `quantity-table.ts` and this cache-rehydrated one -- now call a single shared `groupQuantitySetsByInstance` helper (new `@ifc-lite/data` export) instead of carrying two independent copies of the `(qsetName, qsetGlobalId)` grouping loop, mirroring `groupPropertySetsByInstance` on the property side. A cache round-trip test now asserts parity: a model with two same-named `IfcElementQuantity` instances (distinct GlobalIds) reads back from the binary cache identically to a fresh parse, so the two paths can no longer re-diverge.
