---
"@ifc-lite/geometry": patch
"@ifc-lite/wasm": patch
---

Geometry load-cost reductions for large models (follow-up to #1097 profiling).

Profiling the streaming geometry pipeline on large models (Holter 169 MB / 109 k meshes, bouwkundig 327 MB / 55 k meshes) showed the load is bound by per-element decode + mesh production, NOT by CSG (measured ~2 k / ~246 boolean ops — negligible), distribution, or tessellation. The following reduce redundant per-batch work without changing geometry output (wasm-contract 19/19, mesh counts identical):

- **Cache the geometry-style maps per worker.** The style→RGBA map and the derived `GeometryStyleInfo` index were rebuilt from the session-constant wire arrays on every `processGeometryBatch` call (~18 M HashMap inserts each on a 140 k-styled model). They're now built once per worker, keyed by a cheap signature — a measured ~5 % wall-clock win.
- **Fold the element-colour resolution into the main producer loop** instead of a separate pre-pass that re-decoded every job entity, and decode each entity once via the cached `Arc<DecodedEntity>` (no deep clone). Eliminates a full duplicate decode pass per batch.
- **`MeshCollection.takeMesh`**: move the mesh out of the collection on the streaming read path instead of cloning all vertex buffers, then copying again to JS — one fewer full copy of positions/normals/indices per mesh.
- **Load-time visibility filter** (`ProcessParallelOptions.visibilityFilter` / `globalThis.__IFC_LITE_VISIBILITY_FILTER`): skip geometry jobs for disabled types (spaces, annotations, type-library) at prepass generation so they're never decoded/meshed/uploaded. Toggling a type back on requires a reload.
