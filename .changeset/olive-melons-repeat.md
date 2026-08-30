---
"@ifc-lite/renderer": minor
---

`Renderer.pick()` now reports the `IfcRepresentationItem` behind the surface
that was clicked, not only the owning product, via a new optional
`PickResult.geometryItemId` (#2985). A host can drill from a clicked pane or
frame back to its own entity in the IFC source.

Both pick paths carry it: the flat-mesh GPU pass and the CPU raycast fallback
that every model over the pick-mesh budget takes. `RaycastHit.geometryItemId`
is the CPU half of the same value.

The key is ABSENT, never 0, where there is no item identity to report: the
single merged-mesh fallback, a cached `IfcMappedItem`, a colour-merged batch
(the id would belong to no one entity), and — for now — GPU-instanced
occurrences, for which neither pick route carries a per-occurrence item
channel. Rectangle select still returns bare express ids.

`PickResult` now lives in `pick-resolve.ts` alongside the code that builds it
and is re-exported from `types.js`; the exported surface is unchanged.

Documented in the rendering guide under "Which representation item was picked",
including the drill-to-source step and what an absent key means.
