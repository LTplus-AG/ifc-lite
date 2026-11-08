---
"@ifc-lite/create": minor
"@ifc-lite/viewer": patch
---

In the Model workspace, a new floor slab's top sits at the level and it extrudes down, so walls and columns start on it, and a thickness edit or push/pull keeps the top in place (#9198). `addSlabToStore` takes an optional `ExtrudedDirection` of `[0, 0, 1]` (the default) or `[0, 0, -1]`, which hangs the slab from `Position`. A split keeps a hung slab's pieces hung.
