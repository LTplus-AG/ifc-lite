---
'@ifc-lite/cache': patch
---

Persist the new `QuantityTable.qsetGlobalId` column through the binary cache format and restore the same distinct-instance grouping in `readQuantities`'s `getForEntity`, mirroring `properties.ts`'s `psetGlobalId` handling. Bumps `FORMAT_VERSION` from 16 to 17 (a wire-format-breaking column addition); `FORMAT_VERSION` is embedded in the cache key, so old-format entries simply never key a hit — no read-side migration.
