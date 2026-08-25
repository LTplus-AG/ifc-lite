---
"@ifc-lite/geometry": minor
"@ifc-lite/wasm": minor
"@ifc-lite/cache": minor
---

Carry representation-item identity across the wasm boundary, and stop delivering material ids in the same field.

`MeshData` gains two DISJOINT fields. `geometryItemId` is always the `IfcRepresentationItem` a mesh was tessellated from, so a host can drill from a rendered piece into an `IfcWindow`'s pane or frame and navigate to that entity in source. `materialLayerId` is always the `IfcMaterial` whose layer a mesh slices. Never both — a consumer that ignores the distinction still cannot read one as the other.

The router already kept each item's STEP id and it already reached the server REST payload; `MeshDataJs::from_mesh_data` did not copy it, so the browser never saw it. And for material-layered walls and slabs the same field carried the layer's `IfcMaterial` id, so following it to source landed on the wrong entity with nothing to warn the caller.

`geometryClass === 3` cannot discriminate the two: it is stamped from a static material-index check made before the geometry runs, while the layered path can bail at runtime and emit representation-item submeshes under that class. The discriminator therefore lives on `SubMeshCollection`, set where the layered slabs are built.

Both fields cross the boundary, both converters carry them, and the cache format gains them at v14 — without that, a cache-restored session silently lost the identity.
