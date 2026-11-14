---
"@ifc-lite/rhino3dm": patch
---

Six robustness fixes in the Rhino `.3dm` reader and writer (#10021).

- What the triangle budget draws no longer depends on `bakeInstances`. It was charged per block with `bakeInstances: false` and per mesh with `true`, so a block of two 12-triangle boxes at `maxTriangles: 12` refused the file in one mode and returned one box in the other. A placement whose block reach keeps the f32 range is now admitted whole or left out whole in both modes; what a placement draws beside those meshes, and the meshes of a placement the reach refuses, are charged one part at a time, as before and the same either way.
- `readRhino3dm` and `writeRhino3dm` reacquire the wasm module until it is the one still in use, through one helper that runs the parse or the write in the same step as its check. One recheck left a third read, waiting through two aborts in a row, parsing with a module that had just been discarded; the writer had no recheck at all.
- The block walk checks the placement limit on every reference, skipped ones included, so it stops on the reference that spends the budget instead of walking to the end of the block it is in.
- A composed transform no longer carries the rounding noise `IFC::WorldFromModel` is allowed in its last row: that noise grows with the translation it meets, and an identity frame holding 1e-17, composed with a placement a million metres out, refused every block instance under a frame that had been accepted.
- Layer paths are built from the parent order the reader settles on, not from rhino3dm's `Layer.fullPath`, which follows `ParentId` with no visited set and does not return for a cyclic chain. Paths of well-formed files are unchanged.
- A table row the binding does not hand out is reported as a damaged file instead of escaping as a `TypeError`.
