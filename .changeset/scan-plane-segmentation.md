---
"@ifc-lite/wasm": minor
"@ifc-lite/geometry": minor
---

Detect planes in point clouds (#6870). `IfcAPI.segmentScanPoints(positions, optionsJson)` averages the points into voxels with exact integer sums, so the result does not depend on point order. It then estimates PCA normals, grows regions from the flattest voxels, refits each region with a median/MAD trim and merges coplanar neighbours. For each plane it reports the equation, centroid, inlier count, area, in-plane extent, a horizontal/vertical/sloped hint and, when a scanner position is given, the scanned side. `@ifc-lite/geometry/scan-segmentation` exports the typed `segmentScan` wrapper (named for the whole segmentation, not only planes), which also accepts a reservoir sample with a `count`.
