---
'@ifc-lite/cli': minor
---

Fix `ifc-lite query --group-by <key> --offset <n>` on the plain path (no `--where`, no `--storey`) silently skipping rows out of the underlying filtered set before grouping, instead of grouping the full filtered set the way the `--where` and `--storey` paths already do.

`queryCommand` builds one shared `QueryBuilder` and applied `.limit(rowLimit)`/`.offset(offset)` to it before branching on `--group-by`. The `.limit()` call was guarded with `!groupBy` so it never truncated a group-by query, but `.offset()` had no such guard, so `--group-by type --offset 2` reached the grouping step with 2 rows already removed from the front of the set — changing which entities landed in which group — while the same combination on `--where`/`--storey` groups the full filtered set and ignores `--offset`. `.offset()` now carries the same `!groupBy` guard as `.limit()`, so all three paths agree: under `--group-by`, `--offset` no longer reaches the entity set at all. `--limit` is not ignored under `--group-by` — it is repurposed there as a cap on the number of groups printed, which this change leaves alone. A script combining `--group-by` with `--offset` on the plain path will now get a different (and correct) answer.
