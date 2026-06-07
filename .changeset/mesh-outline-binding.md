---
"@ifc-lite/wasm": minor
---

Add `meshOutline2d(positions, indices, axis, flipped)` — a winding-robust 2D
footprint outline of a triangle mesh for construction projection (#979). It
projects every triangle to the section plane and unions the areas via
`i_overlay`, so the footprint is correct regardless of the mesh's (unreliable)
triangle winding — unlike normal-based silhouette extraction. Returns a
`MeshOutlineJs` handle exposing the contour rings plus the element's extent
along the cut axis for band classification.
