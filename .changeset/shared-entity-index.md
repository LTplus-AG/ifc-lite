---
"@ifc-lite/geometry": patch
---

Share one binary-searchable entity index across geometry workers instead of each
worker building its own 12.6M-entry FxHashMap. `setEntityIndex` now builds a
`SharedEntityIndex` (a sorted `(id,start,end)` buffer looked up by binary search)
from the index columns the orchestrator already streams to each worker, and the
batch decoder uses it. On a 722MB / 12.6M-entity model this cuts each worker's
index from ~354MB to ~152MB (~600MB lower peak across 3 workers) and drops the
per-worker hashmap inserts, easing the memory pressure that slowed large loads in
multi-model sessions. Geometry output is byte-identical (same id→span lookups);
the owned index path is unchanged when no columns are provided (CLI/server).
