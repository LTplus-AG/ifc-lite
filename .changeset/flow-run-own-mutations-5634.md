---
"@ifc-lite/viewer": patch
---

A flow run now records, and Publish takes, only the mutations the run itself made through `bim`. A property edit made by hand while the run was in flight was "pending after, not before" the run and was published as the run's; it is now excluded. The same exact attribution applies to `bim.mutate.batch` / `batchAsync` undo grouping in the viewer: an edit made through the UI while an async batch is open keeps its own undo step instead of being reverted with the batch (#5634).
