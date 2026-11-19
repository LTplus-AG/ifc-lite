---
"@ifc-lite/wasm": patch
"@ifc-lite/cli": patch
---

Retained meshes are now reproducible. The SMLib kernel listed the vertices and triangles of a Boolean result in an order that changed from run to run, and could split a flat four-sided face along either diagonal. The retained adapter now emits every mesh in one canonical order and splits such faces along a fixed diagonal, so the same model gives byte-identical retained geometry every time. Positions, normals, face keys and areas are unchanged; only vertex and triangle order differ from earlier releases. The default exact engine and default wasm are unchanged.
