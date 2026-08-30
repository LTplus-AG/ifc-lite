---
'@ifc-lite/cli': patch
---

Fix `ifc-lite query --sum`/`--avg`/`--min`/`--max` silently aggregating only the first `--limit` matched entities instead of the full filtered set, when used without `--where` or `--storey`.

The plain (no `--where`, no `--storey`) query path built one `QueryBuilder` and applied `q.limit(rowLimit)`/`q.offset(offset)` to it unconditionally (except when `--group-by` was also given), then reused that same sliced builder for the aggregation branches. `--type IfcBeam --sum NetVolume --limit 2` returned the sum of only the first 2 matching beams and reported `matchedEntities: 2`, with no indication the total was partial — silently wrong rather than an error. The `--where` path already had an explicit rule against this ("aggregations operate on the full filtered set, no offset/limit"); the plain path now follows the same rule.
