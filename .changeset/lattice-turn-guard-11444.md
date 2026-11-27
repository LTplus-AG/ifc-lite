---
"@ifc-lite/renderer": patch
"@ifc-lite/wasm": patch
---

Thin round members such as Ø12 mm rebar no longer draw with crumpled bends and a non-round section. The ~1 mm vertex lattice now also refuses an entity when more than 5% of its area turns its face by over 20° there, not only when more than 1% collapses. The renderer keeps only such entities on f32 positions, in a batch of their own colour, so the rest of that colour stays quantized. The compact encoder moves such a mesh to a finer lattice level.

Cold storage remembers each batch’s original pieces so a restore keeps the rebar in f32 and the wall quantized, even when same-colour pieces of one entity arrive at different times.
