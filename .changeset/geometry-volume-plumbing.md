---
'@ifc-lite/geometry': minor
---

Carry the per-entity **proved enclosed volume** out of wasm, so the diff engine can weigh one element against several (issue [#1891](https://github.com/LTplus-AG/ifc-lite/issues/1891)).

`MeshCollection.geometryVolumeValues` shipped in #1993 and had no TypeScript consumer; #2005 plumbed the world AABB and deliberately left the volume behind, because carrying an array nothing reads is dead weight on every batch. The split/merge detector reads it, so it is plumbed now, along exactly the same three paths the box takes:

- `MeshData.geometryVolume`, off the shared extractor in `geometry-fingerprints.ts`, gated by the same `enableGeometryHashes()` switch as the hash it travels with.
- the worker boundary, as a transferable `Float64Array` with one value per hashed id — the same index-parallel layout the wasm getter uses, `NaN` reserving the slot of an entity whose volume was not proved rather than shortening the array.
- `GeometryResult.instancedGeometryVolumes`, the instanced-only side-channel. Not an afterthought: an element is GPU-instanced precisely because it is one of many identical copies, and a precast slab field is exactly the population a split claim is made of.

`geometryVolumeAt` is exported alongside `geometryAabbAt` for consumers decoding that side-channel off the streaming `batch` event.

**Absent means NOT PROVED.** A value exists only where the meshed geometry was provably a single closed, orientable, single-component solid; measured coverage on a real corpus is 71.4% (24,073 of 33,701 elements). The `NaN` sentinel is resolved to `undefined` at the wasm boundary — as is a zero or a negative, which is a degenerate or inside-out solid rather than a small one — so nothing downstream ever holds a number it cannot believe. It is the volume of what was actually meshed, after opening cuts, so it is not an IFC `BaseQuantities` `GrossVolume` and must not be compared against one.
