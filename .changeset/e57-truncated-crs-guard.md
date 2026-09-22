---
"@ifc-lite/pointcloud": minor
---

`inspectE57SpatialMetadata` and `E57StreamingSource.open()` now throw when the E57 XML metadata section reads shorter than its declared length (a truncated blob), instead of silently returning `undefined` as if the file had no CRS. Point-data reads keep their existing tolerance for an over-reported `recordCount`.
