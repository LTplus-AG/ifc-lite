---
"@ifc-lite/geometry": minor
"@ifc-lite/renderer": patch
"@ifc-lite/viewer": patch
---

Inline point clouds can carry a double-precision origin (#10029). `PointCloudAsset` has a new optional `origin` with the same contract as `MeshData.origin`: point i sits at `origin + chunk.positions[3i..3i+3]`, and `chunk.bbox` is relative to it. Absolute float32 positions put a cloud at national-grid coordinates (x = 2,600,000 m in Swiss LV95) on a 0.25 m grid; a producer that sets `origin` avoids that. The renderer uses the origin as the cloud's float64 placement, the path a streamed scan's decode origin already takes, so drawing, picking, snapping and fit-to-view keep millimetres. The viewer's 2D scan section places the cloud through it too, and the federation's RTC re-base now moves a model's inline clouds with its meshes instead of leaving them in the old frame. That re-base gives an origin-less cloud an origin (the move); otherwise a cloud without an origin behaves as before. No reader sets `origin` yet: the IFCX reader narrows to float32 before an origin could be split off, so IFCX clouds load with absolute positions, and the Rhino `.3dm` adapter will adopt it in a follow-up.
