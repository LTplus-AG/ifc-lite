---
"@ifc-lite/wasm": minor
"@ifc-lite/geometry": minor
---

Scan segmentation also detects cylinders (#6870), such as columns and pipes. They are sought among the voxels clear of every plane: a seeded RANSAC from point and normal pairs per smoothly connected group, then a least-squares refit. Spheres, flat facets meeting at an angle, fragments whose arcs disagree from height to height, narrow arcs, short pieces and radii under two voxels are refused; a surface found twice is reported once, and coaxial pieces separated by a short band without points are joined. Every refusal is counted in `stats`. Each cylinder reports its axis, radius, length, height range, arc coverage and inliers. The new options (`detectCylinders`, the radius, fraction, arc and length bounds, the draw, sample and group budgets) are typed in `@ifc-lite/geometry/scan-segmentation`.
