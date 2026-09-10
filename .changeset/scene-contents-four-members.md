---
"@ifc-lite/renderer": minor
---

`SceneContents` (the scene surface `Renderer.getScene()` publishes) now exposes four `Scene` members an external consumer reported reaching for: `getMeshData`, `forEachMeshData`, `getEntityTransform`, `getEntityLocalBounds` (#4357).

All four were already public on the `Scene` class and reachable at runtime through the narrowed `getScene()` return type only by a cast; this is a type-only widening, and `SceneContents` still declares nothing `Scene` does not itself implement, so nothing about the existing published members changes.

`getMeshData` is the single-mesh accessor `getMeshDataPieces` does not directly give (the first mesh piece carrying an entity's placement). `forEachMeshData` visits every flat mesh piece, for a consumer that needs the mesh data itself rather than only the id set `getAllMeshDataExpressIds` returns. `getEntityTransform` is the resolved local-to-world placement (row-major 4x4, `Float64Array`) for one entity. `getEntityLocalBounds` is an entity's bounds in its own pre-transform frame, unioned across occurrences — unlike `getEntityBoundingBox`, which is post-transform and world-axis-aligned and cannot be unioned meaningfully across differently-placed occurrences of the same entity.
