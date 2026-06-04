---
"@ifc-lite/lists": minor
---

Add `ListDefinition.expressIdsByModel` — an explicit element-snapshot scope
keyed by model.

When set, `executeList` targets exactly the express IDs captured for the
current model (so a federated list never over-selects when local express IDs
collide across files), with `conditions` still applied on top and
`entityTypes` ignored. Lets a search/filter result be frozen into a list
(#917 §4).
