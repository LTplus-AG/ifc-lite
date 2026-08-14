---
'@ifc-lite/wasm': patch
---

Fix half-space plane clipping (`IfcHalfSpaceSolid`/`IfcPolygonalBoundedHalfSpace`
subtracts, layered-material band splitting) dropping or misclassifying geometry far
from the model origin. `ClippingProcessor` classified each triangle vertex against
the clip plane with a fixed `epsilon = 1e-6`, but the plane arrives in world
coordinates (f64, from `IfcAxis2Placement3D`) while mesh vertices are f32-native.
Once a world coordinate passes roughly 8.4 m from the origin, the f32 rounding step
exceeds that fixed epsilon, so a vertex meant to sit exactly on the plane (e.g. a cut
flush with a box face) could land on the wrong side of it — non-monotonically, since
it depends on which way the rounding lands rather than on distance alone. A unit-box
flush cut at 1e-6 lost its entire cross-section at a 100.7 m offset and again at a
50000.7 m offset, while surviving at 1000.7 m and 5000.7 m in between.

`clip_mesh` now scales the classification epsilon to the clip operand's coordinate
magnitude directly (`extent · 2⁻²²`, the f32 ULP fraction), floored at the original
`1e-6` constant. This does not reuse the exact CSG kernel's `near_band_from_extent`
helper (`kernel::mesh_bridge`): that helper's floor is `8·SNAP_GRID` ≈ 1.22e-4, sized
for its own snap grid, and its scaling term only exceeds that floor past ~512 m —
so for ordinary building-scale models it would have replaced the old `1e-6` with a
flat 122x-looser epsilon everywhere, not a magnitude-proportional one.
