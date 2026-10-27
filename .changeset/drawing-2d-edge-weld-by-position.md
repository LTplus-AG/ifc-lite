---
"@ifc-lite/drawing-2d": patch
---

`EdgeExtractor.extractEdges` now matches triangle edges by vertex position instead of by vertex buffer index. Meshes that repeat their vertices per face, which is how the geometry pipeline emits flat-shaded solids, no longer report every triangle edge as a `boundary` edge (and so as a silhouette in every view); their outline edges are classified as creases as intended. Coincident vertices are welded with a tolerance of two f32 ULPs of the mesh's own coordinate magnitude, and zero-area triangles are ignored.
