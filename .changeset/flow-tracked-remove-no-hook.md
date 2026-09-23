---
"@ifc-lite/flow": patch
---

Fix a tracked node whose `NodeDef` has no `remove` hook reporting vanished elements as removed and dropping their entries from the tracking store, orphaning them in the model with no way to retry. The scheduler now warns, counts them as not removed, and retains their entries, matching how the orphan sweep already handles this case.
