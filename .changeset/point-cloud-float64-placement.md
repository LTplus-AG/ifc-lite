---
"@ifc-lite/renderer": minor
---

`Renderer.getPointCloudPlacement(handle)` returns a copy of a point cloud's exact float64 placement (import alignment and manual placement composed). `getPointCloudTransform` is the float32 GPU copy and rounds map-grid translations (LV95, UTM) by centimetres, so CPU code that maps scan coordinates into the world must use the new getter.
