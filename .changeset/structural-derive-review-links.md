---
"@ifc-lite/viewer": patch
---

Derive analytical model review (#10605): element ids in the review lists select and frame their element; after Apply, "Show analytical model" switches to the analytical view and selects the new analysis model; a model that already has an analysis model still says why nothing is derived, then lists where the two models disagree (stale and drifted members first, the same checks `ifc-lite validate` runs) or says they are consistent, with a link to show each analysis model.
