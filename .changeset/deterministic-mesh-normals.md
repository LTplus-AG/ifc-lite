---
'@ifc-lite/wasm': patch
---

The router's local geometry cache decided a hash hit by comparing positions and indices, leaving normals out on the premise that they follow from positions. They do not: normals are derived in f64 from the source coordinates and narrowed independently, so a source difference below the f32 position ULP survives in them while the positions come out byte-identical. Two rectangular openings authored at the same size, one ring coordinate at `0.7` and the other at `0.699999999999999`, are that pair. The cache served one for the other, and which of the two filled it first decided whose normals both got, so meshing one file twice in a process did not always give the same bytes. The predicate now compares every field of the mesh, and compares the per-vertex buffers bit for bit so a `-0.0` normal is no longer served for a `+0.0` one.
