---
"@ifc-lite/wasm": patch
"@ifc-lite/cli": patch
---

Retained meshes are now emitted in a canonical order. The SMLib kernel listed the vertices and triangles of a Boolean result in an order that changed from run to run, and could split a flat four-sided face along either diagonal. The retained adapter now sorts vertices by their exact coordinates and triangles by source face, starts each triangle at its smallest vertex, and splits a flat, strictly convex face of exactly two triangles through its lowest vertex. For a given engine build the same model now gives the same retained mesh bytes on every run, as long as the mesh contains none of the cases below.

The kernel's own triangulation is still kept, so the output can still depend on its run-to-run order, for a flat face of more than two triangles, a curved face other than a cylinder, and a cylinder triangle pair whose diagonal the adapter's existing alignment or chord checks leave alone. Native and WebAssembly builds can also order a mesh differently: the order follows exact coordinate bits, and their positions can differ in the last digits.

Index arrays differ from earlier releases. Vertex and triangle order changes, and where a two-triangle flat face used the other diagonal its connectivity changes too. Positions, face keys, per-face areas and per-face normal directions are unchanged. Flat normals are recomputed from the longest of each triangle's three corner cross products, so a thin sliver keeps its true orientation. The default exact engine and default wasm are unchanged.
