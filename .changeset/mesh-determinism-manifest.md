---
"@ifc-lite/geometry": patch
"@ifc-lite/wasm": patch
---

Enforce and harden mesh-output determinism (pinned cross-target manifest).

`consolidate_coplanar` emitted CSG-cut meshes in FxHashMap plane-bucket
iteration order, which differs between 64-bit native and 32-bit wasm32
(FxHasher mixes usize-wide chunks): the same cut produced the same triangles
in a different order per target. The buckets are now a BTreeMap, making
every cut mesh byte-identical native == wasm32 (order-only change; the
triangle set is untouched).

The prepass flat wire arrays (`flat_voids`, `flat_material_colors`,
`flat_styles_rgba8`) are now emitted sorted by id (u32 ascending) - an
explicit wire-order contract instead of an implicit hash-order artifact.
Consumers rebuild maps from these arrays, so behaviour is unchanged.

A new mesh-output determinism manifest
(`rust/processing/tests/manifests/mesh_determinism.json` + wasm32 pair) pins
the full pipeline's emitted bytes at Medium tessellation across x86_64,
arm64 and wasm32, wired into the determinism CI workflow. Contract:
`docs/architecture/mesh-determinism.md`.
