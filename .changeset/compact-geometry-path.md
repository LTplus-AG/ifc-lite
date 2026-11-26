---
"@ifc-lite/geometry": minor
"@ifc-lite/renderer": minor
---

Compact GPU records, end to end and off by default. With `ProcessParallelOptions.compactCellSize` (or `GeometryProcessor.compactCellSize`) set, the geometry workers encode eligible flat meshes as final 12-byte quantized vertices and such a mesh arrives with `MeshData.compact`; its `positions`, `normals` and `indices` decode from the records on first read, so existing consumers keep working. The new `@ifc-lite/geometry/compact` subpath holds the small helpers for these meshes and `loadCompactGeometry()`, which fetches the record decoder on demand; a host awaits it, and the renderer's `loadCompactPages()` for its page code, before asking for compact records, so neither is in a bundle's eager path. The renderer uploads compact meshes into u16 pages without reading a vertex where that is exactly what its bucket path would draw, and moves them back to buckets before any edit, move, recolour or release. `BatchedMesh.indexFormat` names a batch's index width. Nothing changes unless a host passes a cell size.
