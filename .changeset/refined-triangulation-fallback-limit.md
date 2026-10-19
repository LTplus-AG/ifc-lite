---
"@ifc-lite/wasm": patch
---

Keep large declined rings away from earcut in the coplanar consolidation. When the quality CDT declines a region of more than `EARCUT_FALLBACK_MAX_VERTICES` (4,096) vertices, the element keeps its raw kernel mesh, as it already does for any region that fails to triangulate, instead of handing the region to earcut, which can be quadratic on those rings and hold a geometry thread for minutes. Regions at or under the limit, and every other caller of the refined triangulation, are unchanged.
