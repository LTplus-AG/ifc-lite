---
"create-ifc-lite": patch
---

three.js template: render opaque IFC meshes double-sided and enable `logarithmicDepthBuffer`. IFC triangle winding is not reliably outward (the native renderer draws with `cullMode: 'none'` for the same reason), so culling one side of two coincident coplanar walls left the survivors z-fighting into a comb along the seam; and IFC models far from the origin with stacked near-coplanar slabs (a roof on a gable wall) stair-stepped without a logarithmic depth buffer. Both are fixed in the scaffolded viewer.
