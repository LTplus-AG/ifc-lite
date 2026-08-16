---
'@ifc-lite/wasm': patch
---

Fix half-space plane clipping (`IfcHalfSpaceSolid`/`IfcPolygonalBoundedHalfSpace`
subtracts, layered-material band splitting) dropping or misclassifying geometry far
from the model origin. `ClippingProcessor` classified each triangle vertex against
the clip plane with a fixed `epsilon = 1e-6`, but the plane arrives in the
representation item's local, pre-scale, file-unit coordinates (f64, from
`IfcAxis2Placement3D`, decoded before `apply_placement` or unit scaling run)
while mesh vertices are f32-native in that same frame. Once a coordinate passes
16 m from the origin, the f32 rounding step exceeds that fixed epsilon, so a
vertex meant to sit exactly on the plane (e.g. a cut
flush with a box face) could land on the wrong side of it — non-monotonically, since
it depends on which way the rounding lands rather than on distance alone. A unit-box
flush cut at 1e-6 lost its entire cross-section at a 100.7 m offset and again at a
50000.7 m offset, while surviving at 1000.7 m and 5000.7 m in between.

`clip_mesh` now scales the classification epsilon to the coordinate magnitude of the
**mesh being clipped** (`2⁻²²`, the f32 ULP fraction), floored at the original `1e-6`
constant. Only the mesh contributes: the plane is f64 end to end and carries no
rounding noise, and its stored point is an arbitrary representative of the plane, so
letting it size the tolerance would make two descriptions of the same half-space clip
differently. The magnitude is tracked **per axis** and projected onto the clip plane's
own unit normal — `eps(n) = max(1e-6, |nₓ|·noiseₓ + |n_y|·noise_y + |n_z|·noise_z)` — rather
than collapsed to a single max over all three axes. The tolerance is compared against
a signed distance measured along one normal, so each coordinate's rounding noise
enters it weighted by that axis's normal component, and an axis orthogonal to the
normal contributes nothing. A max over all axes instead sizes the tolerance to the
operand's distance from the local origin along whichever axis happens to be largest,
even when that axis is irrelevant to the plane being tested: a site-offset model at
x = 1e6 mm clipped by a horizontal plane through a wall spanning z = 0..3000 mm got
0.238 mm where the real f32 rounding step at that z is 2.4e-4 mm — about 1000x too
loose on the only axis that matters, letting genuinely separated geometry classify
as on-plane. Same formulation as `ProjectedPlaneEps`/`epsForPlane` in
`@ifc-lite/clash`'s contact narrow phase.

Note the projected form is not uniformly tighter than a max over axes: for a unit
normal the weighted sum is bounded by `√3 · max` and reaches it for a body-diagonal
normal, so such a plane gets a `√3`-looser tolerance. That is the correct worst case
when all three axes' rounding errors align. Evidence for all of the above is
synthetic (constructed box/slab/triangle fixtures at the stated offsets); no corpus
model has been shown to change output as a result.

This does not reuse the exact CSG kernel's `near_band_from_extent` helper
(`kernel::mesh_bridge`): that helper's floor is `8·SNAP_GRID` ≈ 1.22e-4, sized for
its own snap grid, and its scaling term only exceeds that floor past ~512 m — so for
ordinary building-scale models it would have replaced the old `1e-6` with a flat
122x-looser epsilon everywhere, not a magnitude-proportional one.
