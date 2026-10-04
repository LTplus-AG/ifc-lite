---
"@ifc-lite/wasm": minor
"@ifc-lite/geometry": minor
---

Scan segmentation also detects cylinders (#6870), such as columns and pipes. They are sought among the voxels no plane claimed: a seeded RANSAC from point and normal pairs per smoothly connected group, then a least-squares refit. Spheres, plane-junction creases, narrow arcs and short pieces are refused. Each cylinder reports its axis, radius, length, height range, arc coverage and inliers. The new options (`detectCylinders`, the radius, fraction, arc and length bounds, the draw, sample and group budgets) are typed in `@ifc-lite/geometry/scan-segmentation`.
