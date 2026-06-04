---
"@ifc-lite/lists": minor
---

Add `ListDefinition.expressIds` — an explicit element-snapshot scope.

When set, `executeList` targets exactly those express IDs (intersected with
each model, so a federated list drops foreign ids), with `conditions` still
applied on top and `entityTypes` ignored. Lets a search/filter result be
frozen into a list (#917 §4). IFC express IDs are file-stable, so the
snapshot survives reloading the same model.
