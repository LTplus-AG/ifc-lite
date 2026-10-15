---
'@ifc-lite/wasm': patch
'@ifc-lite/viewer': patch
---

Stop NaN coordinates from aborting the wasm module through a float sort (#7674). Several Rust sorts used `partial_cmp(..).unwrap_or(Equal)`, which is not a total order once a NaN is present, and Rust's sort may panic on that; the wasm build aborts on panic. The clash BVH now orders split candidates exactly like `@ifc-lite/spatial`'s BVH (centre, NaN last, then input position), so a mesh with NaN-vertex triangles builds, and Rust and TypeScript build the same tree when centres tie. `SpacePlateHandle.dragVertex`, `splitEdge` and `addFace` reject a NaN or infinite coordinate with the new `NonFiniteCoordinate` edit error instead of storing it, and a plate build drops a wall segment (or, for `fromWallRects`, a whole wall rectangle) with a non-finite coordinate. Cylindrical and revolved advanced faces with infinite boundary coordinates, and sectioned solids with a NaN station, no longer abort geometry processing. The viewer recognises the new error code.
