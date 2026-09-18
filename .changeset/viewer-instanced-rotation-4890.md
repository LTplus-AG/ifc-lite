---
"@ifc-lite/viewer": patch
---

Rotate GPU-instanced geometry (doors, windows, columns and other repeated elements the viewer draws as instances) when repositioning a model, instead of refusing the whole selection. The rotate panel's bake now pushes every model's declared heading to `Renderer.setModelRotation` and rebuilds the placed spatial index from the renderer's materialized occurrences, so a pick, a measurement or a clash check against a rotated instanced element resolves at its turned position (#4890). Only a pointcloud selection is still refused — it has no heading to give.
