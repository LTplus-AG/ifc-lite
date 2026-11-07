---
"@ifc-lite/renderer": minor
---

Selecting or hovering one object made of tens of thousands of pieces no longer allocates GPU buffers and issues draws per piece. Above 500 pieces, its highlight merges into one mesh per colour and frame, which removes the long main-thread stall at selection. Ordinary objects keep their per-piece highlight. Meshes gain an optional `mergedSelection` field describing what such a merged highlight covers, and `Scene.getMeshDataPieceList` and `Scene.evictHighlightMeshes` are now public.
