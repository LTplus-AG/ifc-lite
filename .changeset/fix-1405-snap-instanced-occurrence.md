---
"@ifc-lite/geometry": minor
"@ifc-lite/renderer": patch
---

Fix measure-snap missing all-but-one occurrence of GPU-instanced geometry (#1405). `Scene.getInstancedMeshDataPieces` materializes one `MeshData` per instanced occurrence, all stamped with the same `expressId` but holding distinct world-space positions. `SnapDetector` cached the deduped vertices/edges/valence keyed on `expressId` alone, so the first occurrence's geometry was served for every later one (whose true world positions are elsewhere) and snap fell back to a free-point face hit — vertex/edge snapping lit up on only a single instance while raycast (which is cache-free) kept working on all of them. Materialized occurrences now carry a stable per-occurrence `occurrenceKey` (new optional field on `MeshData`), and the snap geometry cache keys on `occurrenceKey ?? expressId`, so snap works on every occurrence and the cache no longer collides instanced pieces with a flat mesh of the same `expressId`.
