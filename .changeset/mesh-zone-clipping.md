---
"@ifc-lite/geometry": minor
---

Add mesh vs. convex-volume clipping — the geometry primitive for splitting objects at zone boundaries (#1810).

`clipMeshByHalfSpace`, `clipMeshByConvexVolume` and `partitionMeshByConvexVolumes` cut a closed triangle mesh at the boundary planes of one or more convex volumes (a construction section, takt area or viewer "location zone"), returning one piece per volume plus the remainder that fell outside all of them. `planesFromOrientedBox` turns the viewer's zone shape (an oriented box that rotates about the vertical axis only) into those planes, and `meshVolume` measures a closed piece.

The point of the API is that the pieces are **solids**, not shells: each cut cross-section is closed with a cap, so `sum(meshVolume(parts)) + meshVolume(remainder)` reproduces `meshVolume(input)`. A per-zone quantity taken off a piece is therefore the quantity of that piece, not an approximation derived from bounding boxes. Every piece carries a `capped` flag; when the input was not watertight enough to close, it is `false` and the piece's volume must not be quoted. The flag is always measured, never asserted: an empty plane or volume list hands the mesh straight back, and even on that path `capped` comes from the input's own boundary edges, so an open shell cannot come back claiming to be a solid.

Implementation is Sutherland–Hodgman per triangle against one plane at a time, with the cap rebuilt from the shell's own boundary edges (so cap winding follows the surface it closes rather than an assumed cut direction) and ear-clipped, which handles non-convex cross-sections such as an L-shaped profile. Pure TypeScript — no WASM, no IFC, no renderer; positions come back as `Float64Array` because f32 rounding of cut vertices is large enough to break the volume identity at building-scale coordinates.

Known limits, all documented on the module: coincident vertices must be bit-identical for a cap to close (crossings are computed in canonical vertex-index order so shared edges always agree); a cross-section with holes has each loop triangulated independently, which keeps the volume right but leaves a self-overlapping cap; split volumes must be convex; and vertex attributes (normals, UVs, colours) are not carried through, since the cut introduces new vertices.

Nothing in the viewer or the lists package calls this yet — the primitive lands first, on its own, with its correctness pinned by tests.
