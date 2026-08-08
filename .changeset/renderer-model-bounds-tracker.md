---
"@ifc-lite/renderer": patch
---

Give the renderer's scene AABB a single owner.

`Renderer.modelBounds` was a private field written from four unrelated
concerns — point-cloud upload (`recomputeModelBounds` /
`expandModelBoundsForPointClouds`), mesh load (`updateModelBounds`), the
annotation and alignment overlay uploads (`expandModelBoundsWithFlatVertices`),
and the public `setModelBounds()` — and read by fit-to-view, `getDiagnostics()`
and the section-plane range. Every bounds-mutating method reached into that
field, which is why the point-cloud and 3D-overlay surfaces could not be lifted
out of `index.ts`.

The value now lives in `ModelBoundsTracker`, which pulls its two inputs (mesh
bounds, point-cloud bounds) through injected accessors. No behaviour change:
the tracker deliberately does not notify the camera, because the call sites do
not all push under the same policy — the point-cloud paths push
unconditionally (so an emptied scene clears the camera's bounds), the overlay
paths push only when the value is non-null, the public `setModelBounds()` does
not push at all, and the section-plane branch of `render()` pushes a separate
wrapper object. The mutate-then-`setSceneBounds` pairing therefore stays where
it was, kept atomic by the caller.

No public API change; `index.ts` drops 117 lines.
