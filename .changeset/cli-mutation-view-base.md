---
'@ifc-lite/cli': patch
---

**headless backend**: give the SDK backend's `MutablePropertyView` the parser's on-demand property and quantity extractors as its base (issue [#2004](https://github.com/LTplus-AG/ifc-lite/issues/2004)).

The view was built on `store.properties`, which the columnar parser leaves empty because it serves properties on demand. Without the extractors the overlay's only source is the overlay itself, so `getForEntity(id)` answers with the one edited property set and nothing else — and `StepExporter` re-emits exactly that for every entity with a property mutation while skipping the original records. Editing one property would drop every sibling property in that set on save.

No path through this backend reaches that today: its `bim.mutate` adapter is a no-op, `bim.store` exposes no property mutation, and `bim.spaces.generate` only writes property and quantity sets onto entities it creates in the same pass, which have no base to lose. This is the same wiring the MCP backend (#2000) and the viewer's `configureMutationView` already have, closing the gap before something reaches it.
