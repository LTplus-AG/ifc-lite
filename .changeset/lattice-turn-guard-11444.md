---
"@ifc-lite/renderer": patch
"@ifc-lite/wasm": patch
---

Thin round members such as Ø12 mm rebar no longer draw with crumpled bends and a non-round section. The ~1 mm vertex lattice now also refuses a mesh when more than 1% of its area turns its face by over 25° there, not only when it collapses: the renderer keeps that batch on f32 positions, and the compact encoder moves the mesh to a finer lattice level.
