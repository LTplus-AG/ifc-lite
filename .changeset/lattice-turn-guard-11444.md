---
"@ifc-lite/renderer": patch
"@ifc-lite/wasm": patch
---

Thin round members such as Ø12 mm rebar no longer draw with crumpled bends and a non-round section. The ~1 mm vertex lattice now also refuses an entity when more than 5% of its area turns its face by over 20° there, not only when more than 1% collapses. The renderer keeps only such entities on f32 positions, in a batch of their own colour, so the rest of that colour stays quantized. The compact encoder moves such a mesh to a finer lattice level.

When same-colour pieces of one entity span f32 and quantized batches, host eviction keeps both batches’ CPU geometry so a GPU rebuild preserves each piece exactly once.
