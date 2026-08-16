---
'@ifc-lite/wasm': patch
---

Fix the exact CSG kernel welding genuinely separate surfaces together in models
placed far from the project origin. The kernel's near-coplanar band
(`near_band_from_extent`) sized itself from ONE scalar extent, the max
|coordinate| over all three axes of both operands, and then compared that band
against a PERPENDICULAR distance to a specific plane. A signed plane distance is
`dot(v - p, n)`, so each axis's f32 rounding noise enters it weighted by that
axis's normal component and an axis orthogonal to the normal contributes
nothing; collapsing to the max therefore sized the band from an axis the plane
never sees.

A georeferenced model 10 km out in X, cut by a Z-normal plane, got a ~2.4 mm
band derived entirely from the X magnitude where the real f32 rounding step in Z
is the ~122 um floor. Surfaces a genuine 2 mm apart fell inside it, were
reconciled as flush, and thin cuts collapsed: the same 2 mm recess that cuts
correctly at the origin returned the uncut slab 10 km out (volume
0.3000030517580399 instead of 0.29968), i.e. the recess vanished from the
result.

The band is now kept PER AXIS and projected onto the plane's own normal,
`sum_i |n_i| * extent_i * 2^-22`, floored at the unchanged `8 * SNAP_GRID` snap
scatter envelope. This is the formulation already adopted for the CSG clipper's
plane epsilon (`csg/plane_eps.rs`), the clash narrow phase
(`packages/clash/src/contact/narrow-phase.ts`) and the section cutter
(`packages/drawing-2d/src/section-cutter.ts`), not a fourth one. Comparisons are
made in the `|n|`-scaled space, so no normal is normalised and no square root is
taken: determinism (byte-identical native == wasm) is unchanged, as is behaviour
at the origin.
