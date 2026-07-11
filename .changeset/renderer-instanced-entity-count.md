---
"@ifc-lite/renderer": patch
---

Add `Scene.getInstancedEntityCount()` (O(1)) so size heuristics — like the viewer's orbit-pivot raycast skip — can account for GPU-instanced entities. On instanced-heavy CATIA-class models the flat mesh/batch census reads deceptively small, and the first pointer-down pivot raycast then materializes tens of thousands of occurrences and builds a BVH over millions of triangles, a visible input-to-first-orbit-frame stall.
