---
"@ifc-lite/viewer": patch
---

Streaming point clouds (LAS / LAZ / PLY / PCD / E57) now arrive in
the renderer's Y-up convention, matching the IFCx ingest path.

Without this, scans rendered rotated 90° onto their side because the
renderer is Y-up internally and LIDAR / surveying formats store data
Z-up by convention. The IFCx path applied the swap inside
`pointcloud-extractor.ts`; the streaming path went straight from the
worker's decoded chunk into `appendPointCloudChunk`, skipping the
swap.

`ingestPointCloud` now wraps `onChunk` to re-orient positions and
bbox before forwarding to the renderer:
  Z-up:  X=right, Y=forward, Z=up
  Y-up:  X=right, Y=up,      Z=back   (negate Y to keep right-hand rule)

Mirrors the geometry / pointcloud extractors' existing handling.
