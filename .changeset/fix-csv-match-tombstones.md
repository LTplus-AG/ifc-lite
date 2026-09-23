---
"@ifc-lite/mutations": patch
---

Fix `csv-match.ts`'s row-matching index (all four strategies — GlobalId, Express ID, Name, and Tag — plus the `property` strategy's index) matching, counting, and mutating entities that were already deleted in the mutation view. The deleted entities' writes previously survived `restoreFromTombstone` (undo of the delete). Supersedes the unmerged `fix-5198-csv-tombstone` branch, which patched `CsvConnector.matchRow()` directly before #5230 moved matching into this file and added the `tag` and (now-live) `property` strategies.
