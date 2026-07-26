---
'@ifc-lite/renderer': patch
---

Fold each point cloud's render transform into ray snap queries.

The spatial index behind measure-tool point snapping stores raw decoder
positions, while an aligned (georeferenced) asset is drawn through its
per-asset model matrix. Snapping therefore returned pre-alignment
coordinates: a measurement landed where the point used to be, not where it
is drawn. The query now rewrites the ray into each node's local frame and
converts distances and hit positions back to world space, so snapping
agrees with the rendering. Unaligned clouds take an unchanged fast path.
