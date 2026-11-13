---
"@ifc-lite/renderer": minor
---

Add optional `superseded: true` metadata to recovery failures invalidated by a newer initialization. Preserve the existing `renderer-destroyed` reason and the published failure-reason union so exhaustive consumer switches remain compatible.
