---
'@ifc-lite/renderer': patch
---

Preserve triangle topology for widely separated survey chunks by falling back from an unsafe model-wide f32 batch frame to the chunk-local frame.
