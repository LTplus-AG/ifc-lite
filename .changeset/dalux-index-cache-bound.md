---
'@ifc-lite/source-dalux': patch
---

The Dalux revision-history cache now evicts expired project indexes and keeps at most eight, so reopening the browser no longer accumulates full indexes. A pinned label survives a current-file response without `version`, and a newer pinned revision is listed before stale current metadata.
