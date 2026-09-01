---
'@ifc-lite/server-bin': minor
---

`POST /api/v1/parse/parquet/optimized`'s documented "Mesh deduplication (instancing)" was inert whenever reuse was rotational: the dedup key hashed each occurrence's BAKED (world-space) vertices, and rotation is baked into those vertices, so two instances of one shape at different orientations always hashed distinct. Across models with heavy `IfcMappedItem` reuse (furniture, pipe runs, repeated structural members) `optimization_stats.mesh_reuse_ratio` sat at ~1.0 where 3.6x-72x reuse was available.

The instance table now dedupes by representation identity too: occurrences that share one `IfcMappedItem` / `IfcRepresentationMap` at different orientations collapse to ONE template mesh, verified per occurrence (its derived placement must reconstruct the occurrence's own baked vertices within 0.1mm before it is trusted — otherwise that occurrence falls back to the previous content-hash behaviour, never a wrong placement). The instance table gains nine `rot0..rot8` columns (row-major 3x3, identity for every non-rotated instance) alongside the existing `origin_x/y/z`: `world = origin + R * template_position`. The optimized-format wire version is bumped 2 -> 3; a decoder that only understands v2 must reject v3 rather than silently ignore the rotation.

`optimization_stats.unique_meshes`/`mesh_reuse_ratio` now reflect the real dedup, not a separate content-hash-only estimate.
