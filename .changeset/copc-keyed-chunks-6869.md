---
"@ifc-lite/renderer": minor
---

Point-cloud chunks can be appended under a key and removed individually (#6869): `Renderer.appendPointCloudChunk(handle, chunk, key)` and `Renderer.removePointCloudChunk(handle, key)`. A keyed chunk gets its own snap index, so removing it frees its GPU buffers and takes its points out of measurement snapping while the rest of the asset stays. View-dependent COPC streaming uses this to stream octree nodes in and out of one asset.
