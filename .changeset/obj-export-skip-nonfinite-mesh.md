---
'@ifc-lite/wasm': patch
---

The Wavefront OBJ exporter (`export_obj` / `exportObj`) now skips a mesh carrying a non-finite (`NaN`/`Infinity`) position, normal, or per-mesh origin instead of writing it into the `.obj` text verbatim. OBJ's `v`/`vn` tokens have no lexical form for a non-finite number, and because the exporter folds the per-mesh origin into every position, a single non-finite origin poisoned every vertex of that mesh. This mirrors `usd::mesh_emittable`, the sibling from-bytes exporter over the same `process_geometry` source, and the from-meshes `mesh_input::scrub_nonfinite` gate already applied to GLB/COLLADA/KMZ.
