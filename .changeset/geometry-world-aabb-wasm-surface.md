---
'@ifc-lite/wasm': minor
---

`MeshCollection.geometryAabbValues`: per-entity world bounding boxes from the geometry-hash pass.

A new read-only member on the committed type surface (`packages/wasm/pkg/ifc-lite.d.ts`), so this is additive public API. Nothing was removed or renamed.

Six `f64` per entry, `[minX, minY, minZ, maxX, maxY, maxZ]`, in `geometryHashIds` order — entry `i` occupies `[6*i, 6*i+6)`, so the array is always exactly `6 * geometryHashCount` long. An entity with a hash but no box reserves its six slots as `NaN` rather than shortening the array, which would mis-attribute every later entry. Populated only when `IfcAPI.setComputeGeometryHashes()` is on, the same switch that gates the hashes; empty otherwise, so nothing is computed when the diff feature is off.

The box is in the WebGL Y-up frame, like every other box, position, origin and placement crossing this boundary. It carries absolute world coordinates (the file's RTC folded back in) while `positions` are RTC-relative, so a consumer comparing the two folds `rtcOffset*` in. See `docs/api/wasm.md`.

Why: a changed geometry hash conflates *moved*, *reshaped* and *re-tessellated* into one bit, which is what makes the diff engine's `moved` match kind a guess. The box separates them — same extent at a new centre is a move, a different extent is a reshape, an identical box with a different hash is retriangulation.

No companion volume is exposed. A divergence-theorem volume needs a closed, consistently wound surface, and 14.7% of the mesh segments reaching this pass are open or non-manifold, where that sum is arbitrary rather than approximate — and looks like an ordinary positive number from the outside.
