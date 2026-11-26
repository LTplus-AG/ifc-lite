---
"@ifc-lite/renderer": patch
"@ifc-lite/geometry": patch
"@ifc-lite/spatial": patch
"@ifc-lite/wasm": major
"@ifc-lite/viewer": patch
---

`?compactGeom` (off by default) comes much closer to what the f32 load draws, and keeps its memory win. It still differs where buckets draw LOD1 (compact pages have none yet) and where the f32 path keeps a whole batch exact (#9068):

- Quantized bucket batches now place their frame origin on the 2^-9 m lattice, so a vertex lands on the same 2^-10 m node whether it is drawn from a bucket or from a compact page. Before, the bucket lattice was offset by an arbitrary sub-step, which moved edges and flipped near-coplanar faces between the two paths.
- Compact meshes that arrive while the renderer is still probing its quantized pipelines wait, still compact, instead of being decoded to the bucket path for good. Paging no longer depends on how fast that probe finishes.
- The spatial index and the symbolic-annotation fill lookup read a compact mesh's row (its box, its counts) instead of its arrays, which decoded every compact mesh of a load and kept the decode.
- The wasm compact encoder writes each mesh's source vertex count, so the camera fit weighs a compact mesh as the f32 load weighs it, and the outlier trim drops the same far meshes.
  The WASM compact table grows from six to seven columns. Upgrade the geometry worker alongside WASM. Earlier workers assume a six-column stride and misread multi-mesh batches with the new encoder.
