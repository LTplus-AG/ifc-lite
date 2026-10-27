---
"@ifc-lite/renderer": patch
---

`Scene.appendToBatches` now computes the f32 triangle-topology verdict once per mesh and frame and reuses it during bucket routing, instead of scanning every triangle again for each new bucket. Batches, vertex data and bounds are unchanged.
