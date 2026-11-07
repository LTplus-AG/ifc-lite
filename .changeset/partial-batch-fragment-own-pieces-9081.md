---
"@ifc-lite/renderer": patch
---

While a model streams, hiding or isolating elements no longer draws an entity twice when its meshes arrived in two streaming appends (#9081); translucent entities showed this as double blending. Isolating an element of an overflowing colour group also no longer draws nothing while streaming is being finalized.
