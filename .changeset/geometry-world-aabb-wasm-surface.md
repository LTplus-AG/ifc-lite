---
'@ifc-lite/wasm': minor
---

`MeshCollection.geometryAabbValues`: per-entity world bounding boxes from the geometry-hash pass.

A new read-only member on the committed type surface (`packages/wasm/pkg/ifc-lite.d.ts`), so this is additive public API. Nothing was removed or renamed.

Six `f64` per entry, `[minX, minY, minZ, maxX, maxY, maxZ]`, in `geometryHashIds` order — entry `i` occupies `[6*i, 6*i+6)`, so the array is always exactly `6 * geometryHashCount` long. An entity with a hash but no box reserves its six slots as `NaN` rather than shortening the array, which would mis-attribute every later entry. Populated only when `IfcAPI.setComputeGeometryHashes()` is on, the same switch that gates the hashes; empty otherwise, so nothing is computed when the diff feature is off.

The box is in the WebGL Y-up frame, like every other box, position, origin and placement crossing this boundary. It carries absolute world coordinates (the file's RTC folded back in) while `positions` are RTC-relative, so a consumer comparing the two folds `rtcOffset*` in. See `docs/api/wasm.md`.

Why: a changed geometry hash conflates *moved*, *reshaped* and *re-tessellated* into one bit, which is what makes the diff engine's `moved` match kind a guess. The box separates them — same extent at a new centre is a move, a different extent is a reshape, an identical box with a different hash is retriangulation.

Two companions ship alongside it, same switch, same index-parallel rule, same NaN-means-absent convention: `MeshCollection.geometryVolumeValues` (enclosed volume in m³) and `MeshCollection.geometryClosureFlags` (packed topology verdict). A divergence-theorem volume needs a closed, consistently wound surface, so a volume is emitted ONLY where the entity produced exactly one segment and that segment was exactly one closed, orientable component — `NaN` otherwise, which is roughly a third of entities by design. The flags name which clause failed (bit 0 closed, 1 orientable, 2 single component, 3 one segment; `0x0F` is exactly the set carrying a volume), because a refusal without a reason is not actionable. A clear bit means NOT PROVED rather than proved-false: an element whose mesh was edited after the verdict was taken (the f32-collapse degenerate backstop drops triangles, which opens their neighbours) has bits 0-2 retracted and ships no volume.
