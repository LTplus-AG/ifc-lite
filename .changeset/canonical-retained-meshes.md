---
"@ifc-lite/wasm": patch
"@ifc-lite/cli": patch
---

Retained meshes no longer depend on the SMLib kernel's run-to-run enumeration order. The kernel listed the vertices and triangles of a Boolean result in an order that changed between runs, and could split a flat four-sided face along either diagonal. The retained adapter now emits every mesh with its vertices in coordinate order and its triangles sorted by source face, and splits a flat face made of exactly two triangles along a fixed diagonal (through its lowest vertex), so such meshes are byte-identical every run. Index arrays therefore differ from earlier releases: vertex and triangle order changes, and where a two-triangle flat face used the other diagonal its connectivity changes too. Positions, face keys, per-face areas and per-face normal directions are unchanged; flat normals are recomputed from the new first corner. A flat face tessellated into more than two triangles keeps the kernel's triangulation. The default exact engine and default wasm are unchanged.
