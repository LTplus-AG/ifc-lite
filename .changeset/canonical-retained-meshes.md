---
"@ifc-lite/wasm": patch
"@ifc-lite/cli": patch
---

Retained meshes are now emitted in a canonical form. The SMLib kernel listed the vertices and triangles of a Boolean result in an order that changed from run to run, and could triangulate a flat face differently each time. The retained adapter now sorts vertices by their exact coordinates and triangles by source face, starts each triangle at its smallest vertex, and retriangulates every flat face from its outline alone (a greedy triangulation that adds the shortest interior diagonals first, so a rectangle is split through its lowest corner). For a given engine build the same model now gives the same retained mesh bytes on every run, as long as it contains none of the cases below.

The kernel's own triangulation is still kept, so the output can still depend on its run-to-run order, for a curved face other than a cylinder, a cylinder triangle pair whose diagonal the adapter's existing alignment or chord checks leave alone, and a flat face the retriangulation declines (more than 256 vertices, non-manifold edges, or a result that does not reproduce its triangle count and area). Native and WebAssembly builds can also order a mesh differently: the order follows exact coordinate bits, and their positions can differ in the last digits.

Index arrays differ from earlier releases: vertex and triangle order changes, and flat faces can be split along different diagonals. Positions, face keys, per-face areas and per-face normal directions are unchanged. Flat normals are recomputed from the longest of each triangle's three corner cross products, so a thin sliver keeps its true orientation. The default exact engine and default wasm are unchanged.
