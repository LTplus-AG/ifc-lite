---
"@ifc-lite/pointcloud": minor
"@ifc-lite/viewer": patch
---

Load E57, PLY and LAS point clouds larger than 4 GB. `streamPointCloud` now applies its 4 GB default `maxFileSize` only to formats whose source reads the whole file (PCD, PTS, XYZ, LAZ); E57, PLY and LAS stream from bounded windows and have no default ceiling. LAS strided reads are now capped at 16 MiB per read, so LAS peak memory no longer grows with file size. An explicit `maxFileSize` still applies to every format (#8773).
