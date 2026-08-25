---
"@ifc-lite/geometry": minor
"@ifc-lite/wasm": minor
"@ifc-lite/cache": minor
"@ifc-lite/server-client": minor
---

Carry representation-item identity across the wasm boundary, and stop delivering material ids in the same field.

`MeshData` gains two DISJOINT fields. `geometryItemId` is always the `IfcRepresentationItem` a mesh was tessellated from, so a host can drill from a rendered piece into an `IfcWindow`'s pane or frame and navigate to that entity in source. `materialId` is always the `IfcMaterial` whose layer a mesh slices. Never both — a consumer that ignores the distinction still cannot read one as the other.

The router already kept each item's STEP id and it already reached the server REST payload; `MeshDataJs::from_mesh_data` did not copy it, so the browser never saw it. And for material-layered walls and slabs the same field carried the layer's `IfcMaterial` id, so following it to source landed on the wrong entity with nothing to warn the caller.

`geometryClass === 3` cannot discriminate the two: it is stamped from a static material-index check made before the geometry runs, while the layered path can bail at runtime and emit representation-item submeshes under that class. The discriminator therefore lives on `SubMeshCollection`, set where the layered slabs are built.

Neither field is ever `0`. `IfcMaterialLayer.Material` is optional, so an air gap reaches the mesher as `material_id 0` — that is the decoder's "no reference" sentinel, not an entity, and STEP instance names start at `#1`. Twelve slabs of `duplex.ifc` reported `IfcMaterial #0` before this was filtered at the setter. An air-gap slab is still meshed; it simply reports no material.

Both fields cross the boundary, both wasm converters carry them, the REST wire shape and `convertServerMesh` carry them, and the cache format gains them at v14 — without that, a cache-restored session silently lost the identity.

BREAKING FOR THE RUST CRATE, and this changeset cannot express it. `ifc-lite-processing` is published to crates.io (`scripts/release-crates.mjs`), `MeshData` gains a public field, and `with_style_metadata` goes from two arguments to three — both break a struct literal or a call downstream, which `rust/export/src/usd/tests.rs` demonstrates in-repo. `scripts/sync-versions.js` derives the Cargo workspace version from the highest npm package version, so a `minor` here ships 6.0.0 → 6.1.0 and a consumer pinned to `ifc-lite-processing = "6"` breaks on `cargo update`. Nothing gates this: there is no `cargo-semver-checks` anywhere in the repo.
