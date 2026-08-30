---
'@ifc-lite/cli': minor
---

Fix `ifc-lite query --sum`/`--avg`/`--min`/`--max` silently aggregating only the first `--limit` matched entities instead of the full filtered set, when used without `--where` or `--storey`.

The plain (no `--where`, no `--storey`) query path built one `QueryBuilder` and applied `q.limit(rowLimit)` (skipped only under `--group-by`) and `q.offset(offset)` (skipped under nothing) to it, then reused that same sliced builder for the aggregation branches. `--type IfcBeam --sum NetVolume --limit 2` returned the sum of only the first 2 matching beams and reported `matchedEntities: 2`, with no indication the total was partial — silently wrong rather than an error. The `--where` path already had an explicit rule against this ("aggregations operate on the full filtered set, no offset/limit"); the plain path now follows the same rule. `--group-by` combined with an aggregation also stops applying `--offset` before grouping, so group totals now cover the full filtered set the way the `--where` and `--storey` paths already do.
