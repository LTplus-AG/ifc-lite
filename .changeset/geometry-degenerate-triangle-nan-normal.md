---
'@ifc-lite/wasm': patch
---

Stop the geometry kernel emitting NaN vertex normals.

`Triangle::normal()` normalized the edge cross product unconditionally. A zero-area
triangle — three collapsed or exactly collinear vertices — has a zero-length cross
product, so that was `0.0 / 0.0`: NaN in all three components. `add_triangle_to_mesh`,
its only production caller, wrote those NaNs straight into `Mesh::normals` for every
triangle `ClippingProcessor::clip_mesh` emits, which is the half-space clip and the
material-layer slicing path.

The mesh-hygiene pass did not clean them up, because it was never meant to:
`clean_degenerate` / `drop_thin_triangles` rewrites only `indices`. The degenerate
triangle disappears from the index buffer while its three vertices stay in
`positions` / `normals` as unreferenced orphans, still carrying NaN. On
`tests/models/ara3d/duplex.ifc` that shipped 81 NaN normal components across 6 of 622
meshes — all of them material-layer wall slices, all on vertices no triangle
references.

A degenerate triangle now gets `(0, 0, 1)`, the same undefined-normal convention
`csg::normals::calculate_normals` and the average-normals weld already use, stated in
the kernel's Z-up frame. Non-degenerate triangles are bit-identical: `try_normalize(0.0)`
computes exactly what `normalize()` did for every non-zero cross product. Measured over
duplex.ifc, the only meshes whose output moves are those same 6, and the triangle count
is unchanged (39,334 in both).

NaN normals were not merely cosmetic. They are unrepresentable in any consumer that
hashes or serializes the mesh — every NaN bit pattern collapses to a single quiet NaN,
so two different meshes could hash alike — and they defeat vertex welding, since
`NaN != NaN` keeps coincident vertices from merging.
