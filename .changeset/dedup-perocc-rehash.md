---
"@ifc-lite/geometry": patch
---

Geometry content-dedup: drop the per-occurrence `rep_identity` re-hash and add an
opt-in extra-type gate.

On a content-dedup cache hit the item mesh was cloned and its full 128-bit
`compute_mesh_hash_full` was re-run for instancing `rep_identity` on every
occurrence (tens of thousands of times on repeated steel). The cache now stores
the `rep_identity` beside the mesh, so a hit stamps it as a `u128` copy instead of
re-hashing. Byte-identical output.

Also adds `IFC_LITE_DEDUP_EXTRA` (default OFF) which extends content-dedup to
`IfcPolygonalFaceSet` / `IfcTriangulatedFaceSet` / `IfcShellBasedSurfaceModel` /
`IfcFaceBasedSurfaceModel` (their structural signature is already complete);
gated so low-reuse models never pay the hash for no payback.

Note: the public Rust `ItemDedupCache` value type changes from `Arc<Mesh>` to
`Arc<(Mesh, Option<u128>)>`. The alias is an opaque handle outside the workspace
(keys come from private `item_dedup_key`); this is an intentional 0.x source
break for any external Rust code that constructed map entries by hand.
