---
"@ifc-lite/mutations": patch
---

Fix `BulkQueryEngine.select()` (both the entity-type fast path and the no-filter `getAllEntityIds()` path) selecting, counting, and mutating entities that were already deleted in the mutation view. The deleted entities' writes previously survived `restoreFromTombstone` (undo of the delete).
