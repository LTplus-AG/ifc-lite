---
'@ifc-lite/clash': patch
---

Scale the focused-clash contact-interface epsilon to coordinate magnitude, not a fixed 1e-6.

`contactClusters` (used by the viewer's focused clash detail view, `apps/viewer/src/hooks/useClash.ts`, via `@ifc-lite/clash/contact`) computes the real contact geometry — shared-face polygon, intersection line, or point — between one clashing pair, via a Möller triangle-triangle test whose plane-distance tolerance (`planeEps`) defaulted to a fixed `1e-6` in `narrowPhase`.

Geometry is ingested from f32 buffers throughout this codebase, so a fixed `1e-6` is only valid near the origin: the f32 ULP exceeds `1e-6` above ~8.4 m and reaches ~4.9e-4 at 5 km. Two triangles authored to be exactly flush (a shared wall/slab boundary) round to *adjacent*, not bit-identical, f32 values once far from the origin, and the too-tight fixed epsilon then read that rounding noise as a genuine non-coplanar separation — dropping the shared-face contact entirely instead of reporting the surface. A synthetic pair of boxes flush at world x = 5000.5 m, with one side's boundary coordinate bumped by exactly one f32 ULP (the mechanism `fix(clash): float32-precision floor on penetration depth` measured directly on `Infra-Bridge.ifc`, 20 pairs bit-identical at the f32 ULP for their coordinate magnitude), lost its `surface` cluster entirely under the old fixed epsilon; the same case at 50 km showed the same loss.

The fix, following that same narrow-phase fix's approach: `narrowPhase`'s default `planeEps` is now `max(1.0, maxAbsCoord) * 2^-22` — the pair's own coordinate magnitude (from the two meshes' already-computed BVH root bounds, so no extra pass over the geometry) times the same `2⁻²²` f32-ULP term `near_band_from_extent` uses in `rust/geometry/src/kernel/mesh_bridge.rs` and `precisionFloor` uses in `engine-ts/narrow.ts`. An explicit `planeEps` passed by a caller is unchanged and still wins.

Near the origin, where the f32 ULP is far below `1e-6`, the new default is bit-for-bit identical to the old fixed constant on the existing near-origin fixtures in `contact.test.ts` (the overlapping-boxes and perpendicular-bars cases) — the focused-clash contact output for an ordinary building model near the origin is unaffected.

No API surface change: `planeEps` remains an optional field on `NarrowPhaseOptions`/`ContactOptions`.
