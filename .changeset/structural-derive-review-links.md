---
"@ifc-lite/viewer": patch
---

Derive analytical model review (#10605): element ids in the review lists select and frame their element; after Apply, "Show analytical model" switches to the analytical view and selects the new analysis model; a model that already has an analysis model lists where it disagrees with the physical model (stale and drifted members first, the same checks `ifc-lite validate` runs), or says it is consistent, instead of a bare refusal.
