---
'@ifc-lite/data': major
'@ifc-lite/cache': major
---

Remove `EntityTable.getGlobalIdMap()`.

It was added alongside `getExpressIdByGlobalId()` for BCF integration and never
used — the BCF lookup, tier-0 scan, export adapter, embed handler and CLI
diagnostics all call `getExpressIdByGlobalId()` (point lookups). No caller ever
needed the materialized map.

Carrying it had a real cost: every implementation returned
`new Map(globalIdToExpressId)`, a full defensive copy that would have doubled the
peak memory of the largest string-keyed structure in the table the moment anyone
called it, and it froze a `Map` return type into the canonical interface that
three builders had to keep satisfying in lockstep.

Migration: use `getExpressIdByGlobalId(globalId)` for GlobalId → expressId, and
the existing `getGlobalId(expressId)` column accessor for the reverse. Both are
unchanged.
