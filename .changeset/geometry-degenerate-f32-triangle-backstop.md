---
"@ifc-lite/geometry": patch
---

Drop degenerate f32 triangles so large georeferenced models stop showing gross "fan" corruption.

When a mesh is stored at f32 precision while its vertices sit at building-scale world coordinates (e.g. a model whose extent reaches ~220 m from the coordinate origin), the f32 mantissa only resolves ~15 µm there. Vertices closer together than one ULP round to the same — or near-same — f32 value, so the triangles joining them collapse into zero-area slivers; when the third vertex is far away the result is a long, thin triangle that visibly fans across the whole model.

`Mesh::drop_degenerate_triangles` now runs in `build_mesh_data` — the single funnel every element `MeshData` passes through on both the native and WASM pipelines — and removes only unambiguously-degenerate triangles: a bit-identical f32 vertex pair (exact zero area) or an aspect ratio above 1e5. These slivers carry no area, so neighbouring triangles of the same face already cover the surface and the removal is visually lossless. On a 54 MB georeferenced building model this drops all 664 catastrophic fans (0.29% of triangles) with no change to the remaining geometry, no kernel-determinism impact (predicate-sign manifests unchanged), and the synthetic-coordinate correctness harness stays byte-identical. The complete fix (local-frame / tiled vertex storage that keeps the vertices distinct) is tracked separately; this is the backstop that keeps the viewer clean meanwhile.
