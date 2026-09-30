---
"@ifc-lite/ids": patch
---

Bound IDS compound entity/name lookup caches to prevent Map exhaustion during large validations. Evicted lookups are recomputed without changing validation results. Preserve per-entity source parsing caches so repeated specifications continue to reuse parsed data.

Validations exceeding the retained compound-lookup working set may recompute those lookups, trading additional CPU work for bounded cache retention.
