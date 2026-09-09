---
"@ifc-lite/viewer": patch
---

Register `layerStackSlice` in the viewer store's teardown seam. Removing a federated layer's model, clearing all models, or loading a new file used to leave the Layers panel's composition (`layerStack`, its `path -> expressId` selection bridge, and the per-layer diff) pointing at a model that no longer exists.
