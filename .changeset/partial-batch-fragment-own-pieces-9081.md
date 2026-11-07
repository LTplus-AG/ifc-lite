---
"@ifc-lite/renderer": patch
---

While a model streams, a streaming fragment's hide/isolate draw now covers only its own pieces, so an entity whose meshes arrived in two streaming appends is no longer drawn twice by those fragments (#9081); translucent entities showed this as double blending. Isolating an element of an overflowing colour group also no longer draws nothing while streaming is being finalized.
