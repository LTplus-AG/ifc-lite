---
"@ifc-lite/wasm": patch
---

Fixed a consolidation-only mesh tear (#3914): `consolidate_coplanar`'s plane-bucketing step re-derived each triangle's supporting plane from its f32-rounded vertices, which could straddle the `POS_QUANT` rounding boundary for a rotated/tilted face and split one physical kernel plane into two adjacent buckets that the cross-bucket seam-conform pass (tangential-only) could not stitch back together. `kernel::mesh_bridge::tris_to_mesh` (the kernel boolean's sole `Mesh` producer) now tags every output triangle with its f64 supporting plane, computed before the f32 cast; `consolidate_coplanar` merges exactly the adjacent-bucket-pair case those tags identify as one kernel plane, leaving every other bucket (the overwhelming majority) untouched. A mesh without tags (anything that went through a weld/merge/transform since, or a synthetic/test mesh) is byte-identical to before.
