---
'@ifc-lite/wasm': patch
---

Fix half-space plane clipping (`IfcHalfSpaceSolid`/`IfcPolygonalBoundedHalfSpace`
subtracts, layered-material band splitting) dropping or misclassifying geometry far
from the model origin. `ClippingProcessor` classified each triangle vertex against
the clip plane with a fixed `epsilon = 1e-6`, while mesh vertices are f32-native
and the plane is f64 end to end. The two callers work in different frames — the
half-space path clips inside `BooleanProcessor::process`, in the representation
item's local, pre-scale, file-unit coordinates (the plane decoded in f64 from
`IfcAxis2Placement3D` before `apply_placement` or unit scaling run), whereas the
layered-material path clips an already-scaled, already-placed mesh against
interface planes built in metres — but the f32/f64 mismatch is the same in both.
Once a coordinate passes
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
when all three axes' rounding errors align. The tolerance is also invariant under
negating the plane normal (each component enters as `|nᵢ|`), which the layered path
depends on: it clips one remainder with `+n` and `-n` and welds the two halves, so a
direction-dependent epsilon would leave a gap or an overlap at every material
interface. Evidence for all of the above is
synthetic (constructed box/slab/triangle fixtures at the stated offsets); no corpus
model has been shown to change output as a result.

Two things deliberately left alone. `ClippingProcessor::clip_triangle` — public API
with no in-tree production caller — keeps the flat `1e-6`, so external callers of
that entry point still get the pre-fix tolerance until it is migrated. And the floor
is still a raw constant never rescaled by `unit_scale`, so its physical size depends
on the caller's frame; below the ~4.19-unit crossover where the floor rather than the
projected term wins, a metre-authored and a millimetre-authored file can pick
epsilons differing by `4.194 / E` for a real-world amplitude of `E` metres (~4x at
1 m, ~42x at 0.1 m, unbounded as `E` shrinks). Both sides stay sub-micrometre.
Rescaling that floor is its own change with its own corpus evidence.

This does not reuse the exact CSG kernel's `near_band_from_extent` helper
(`kernel::mesh_bridge`): that helper's floor is `8·SNAP_GRID` ≈ 1.22e-4, sized for
its own snap grid, and its scaling term only exceeds that floor past ~512 m — so for
ordinary building-scale models it would have replaced the old `1e-6` with a flat
122x-looser epsilon everywhere, not a magnitude-proportional one.
