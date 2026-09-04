---
'@ifc-lite/bcf': patch
---

`createBCFFromIDSReport` with `version: '3.0'` now includes required cameras and aspect ratios.

BCF 3.0's `visinfo.xsd` requires exactly one camera per viewpoint and an `AspectRatio` element on each camera, but `createBCFFromIDSReport` violated both: topics without `entityBounds` got no camera at all, and `computeCameraFromBounds` never set `AspectRatio`. The writer would refuse both patterns as invalid.

- `computeCameraFromBounds` now sets a standard 16:9 `aspectRatio`
- `buildEntityViewpoint` creates a default isometric camera when no bounds are available, but only for BCF 3.0 (preserves BCF 2.1 backward compatibility)
- Tests verify both camera requirements are met for BCF 3.0
