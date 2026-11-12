---
"@ifc-lite/source-dalux": patch
---

Keep revision-index cache entries scoped to their API client, retry incomplete reads with fresh version-set pins, and use the first valid file timestamp. Project histories beyond the bounded sweep are explicitly incomplete instead of presenting an arbitrary subset as complete.
