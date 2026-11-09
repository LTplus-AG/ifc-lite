---
"@ifc-lite/renderer": minor
---

A cold raycast on a large federation no longer spends minutes in the garbage collector, and hiding or isolating no longer rebuilds the BVH (#9504). `RaycastEngine` collects the flat pieces once per scene change and builds one BVH over all of them, and visibility filters each ray's candidates. `BVH` now lives in typed arrays and splits in place. New `Renderer.isRaycastCacheWarm()` reports whether the next `raycastScene()` rebuilds anything, so a caller can warm the index off the gesture path.
