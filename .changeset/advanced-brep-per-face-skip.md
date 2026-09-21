---
"@ifc-lite/wasm": patch
---

Fix an `IfcAdvancedBrep`/`IfcAdvancedBrepWithVoids` face that fails to triangulate (e.g. a holed planar face earcut cannot fill without silently closing the authored opening) aborting the whole solid. It is now skipped like `FaceBasedSurfaceModelProcessor` already does, so the rest of the solid's faces still mesh.
