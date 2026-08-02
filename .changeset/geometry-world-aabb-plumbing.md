---
'@ifc-lite/geometry': minor
---

Carry the per-entity world AABB out of WASM: `MeshData.geometryAabb`, `GeometryResult.instancedGeometryAabbs`, `geometryAabbAt`.

Additive public API. `MeshCollection.geometryAabbValues` has existed since the WASM side shipped it, but nothing on this side of the FFI boundary read it, so the box had no consumers at all.

- `MeshData.geometryAabb` — the whole-entity box, alongside `geometryHash` and populated by the same `GeometryProcessor.enableGeometryHashes()` switch. Every submesh of one entity carries the same box, exactly as it carries the same hash.
- `GeometryResult.instancedGeometryAabbs` — the same boxes for entities whose entire geometry went to the GPU-instanced shard and therefore never appears in `meshes`. Keyed by express id, like the existing `instancedGeometryHashes`. Without this the boxes would be missing for precisely the repeated components a positional diff exists to pair.
- `geometryAabbAt(values, index)` — the reader for the six-values-per-id layout, exported because that layout also crosses the geometry-worker boundary as the `batch` event's `instancedGeometryAabbValues`.

Frame: **absolute world in the renderer's WebGL Y-up frame**, with the file's RTC offset and the per-element `origin` already folded in by the producer. Do not add `origin` to it, and do not substitute a box folded from `positions` — those are RTC- and origin-relative, so an element that moved would measure as stationary.

The WASM side writes six `NaN`s for an entity it could not box, so the arrays stay index-parallel. That sentinel is resolved to `undefined` at this boundary: a `geometryAabb` you hold is always a real box, never a NaN-bearing one. A WASM build predating the getter degrades to hashes only, as before.

`geometryVolumeValues` and `geometryClosureFlags` are deliberately NOT plumbed. Volume is groundwork for the split/merge detector, which is a later change; carrying an array nothing reads would be dead weight on every batch.
