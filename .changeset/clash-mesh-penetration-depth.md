---
"@ifc-lite/clash": patch
---

Report the mesh-level penetration depth for every hard clash, not only for contained pairs.

`Clash.distance` for a hard clash was, for most penetrating pairs, the AABB signed gap — the *smallest overlapping bounding-box dimension* of the two elements. For elements that overlap over a wide area but are thin in one direction (stacked pavement courses, a plate, a bar's cross-section), that smallest dimension is a dimension of one of the elements, so the reported "depth" came out as the element's own thickness no matter how far the two solids actually interpenetrated. On a layered road model that surfaces as depths that are exactly the layer thicknesses, repeated across hundreds of clashes.

The mesh-level measurement introduced in #1866 — the distance from the deepest crossing-triangle vertex inside the other solid to that solid's surface — was only run when one element's AABB contained the other's. It now runs for every intersecting pair.

The AABB estimate remains as the fallback for pairs where no crossing-triangle vertex of either mesh lies inside the other (a thin member piercing straight through, so every vertex is outside). In that case the reported number is still an estimate from the bounding boxes, with the same caveat as before.

The Rust/WASM kernel is changed identically, so both engines keep reporting the same numbers.

This costs narrow-phase time: the depth probe casts a ray and runs a closest-surface scan over the other mesh's triangles per deduped crossing vertex, and it now runs on every hard pair instead of the rare contained ones. On a synthetic bench of 300 deeply penetrating pairs, per-pair narrow-phase cost went from 0.22 ms to 2.8 ms at 300 triangles per mesh, and from 0.55 ms to 19 ms at 1200 triangles per mesh.
