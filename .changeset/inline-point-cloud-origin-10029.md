---
"@ifc-lite/geometry": minor
"@ifc-lite/renderer": patch
"@ifc-lite/viewer": patch
---

Inline point clouds can carry a double-precision origin (#10029). `PointCloudAsset` has a new optional `origin` with the same contract as `MeshData.origin`: point i sits at `origin + chunk.positions[3i..3i+3]`, and `chunk.bbox` is relative to it. Absolute float32 positions put a cloud at national-grid coordinates (x = 2,600,000 m in Swiss LV95) on a 0.25 m grid; a producer that sets `origin` avoids that. The renderer uses the origin as the cloud's float64 placement, the path a streamed scan's decode origin already takes, so drawing, picking, snapping and fit-to-view keep millimetres. A cloud whose origin is not finite is skipped with a warning by `setPointClouds` and `addPointClouds` instead of failing the batch.

Inline clouds now move with their model's meshes: the viewer's federation RTC re-base moves them through `origin` (including a model that holds only inline clouds), georeference alignment moves them same-CRS and cross-CRS, and a realign rollback restores them. A moved cloud gets `origin` set even if it had none. The 2D scan section places clouds through their origin too. Otherwise a cloud without an origin behaves as before. No reader sets `origin` yet: the IFCX reader narrows to float32 before an origin could be split off, so IFCX clouds load with absolute positions, and the Rhino `.3dm` adapter will adopt it in a follow-up.
