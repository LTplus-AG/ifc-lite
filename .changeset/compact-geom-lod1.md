---
"@ifc-lite/renderer": patch
"@ifc-lite/geometry": patch
"@ifc-lite/wasm": patch
---

Compact geometry (`compactGeom`, off by default): pages take the decisions of the bucket batches they stand in for. At the end of a stream each page is rewritten bucket by bucket and gets a LOD1 range per bucket, clustered from its own records with the bucket's cell size. The draw loop culls each part and picks its LOD on the bucket's box. Meshes whose bucket would stay exact f32 (#9068, or wider than the lattice range) move to buckets. Nothing changes with compact geometry off.

Compact LOD1 uses the authored corner normals retained by the encoder. Older payloads keep full detail. A stream reconciles each bucket that receives f32 meshes, including when an edit moves another mesh during the same stream.
