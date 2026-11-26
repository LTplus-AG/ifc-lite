---
"@ifc-lite/renderer": patch
---

Compact geometry (`compactGeom`, off by default): pages take the decisions of the bucket batches they stand in for. At the end of a stream each page is rewritten bucket by bucket and gets a LOD1 range per bucket, clustered from its own records with the bucket's cell size. The draw loop culls each part and picks its LOD on the bucket's box. Meshes whose bucket would stay exact f32 (#9068, or wider than the lattice range) move to buckets. Nothing changes with compact geometry off.
