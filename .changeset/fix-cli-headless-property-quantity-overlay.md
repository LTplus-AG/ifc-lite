---
'@ifc-lite/cli': patch
---

`HeadlessBackend.query.properties()`/`quantities()` read `EntityNode` directly off the parsed store and never consulted the `MutablePropertyView` overlay this same backend already creates for `bim.mutate.*` / `bim.export.ifc()`. So `bim.mutate.setProperty(...)` followed by `bim.properties(ref)` — or `bim.mutate.deleteProperty(...)` followed by the same read — silently returned the pre-edit value in the same session, even though `bim.export.ifc()` on that session already reflected the edit. Everything built on `bim.properties()`/`bim.quantities()` inherited the staleness: `export --format csv|json`, the `props` command, `query --where`. #3498 folded the overlay into entity add/remove visibility and explicitly left this half out of scope; now fixed via `MutablePropertyView.getForEntity()`/`getQuantitiesForEntity()`, the same merge `StepExporter` already reads.
