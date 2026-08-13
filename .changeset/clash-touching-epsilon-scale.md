---
'@ifc-lite/clash': patch
---

Scale the "touching" band (`isTouching`, used by the viewer's `hideTouching` clash filter, touching-count badge, and per-row touching indicator) to a clash's own coordinate magnitude, not a fixed 1e-4 metres.

Geometry is ingested from f32 buffers, so a fixed `TOUCHING_EPSILON` is only valid near the origin: the f32 ULP for a coordinate of magnitude `extent` is `extent * 2^-22`, and exceeds `1e-4` once `extent` passes ~1 km. Past that distance, a genuinely flush pair (a wall meeting a slab) can pick up more than `1e-4` of pure f32 rounding noise in its measured penetration depth, and the fixed band then misses it — the pair silently reappears as a hard clash in a list the user explicitly asked to de-noise. Demonstrated directly through `isTouching`: a flush pair 1 f32 ULP apart at each corner classifies as touching near the origin, but past the ULP-crossover distance (~1024 m for a single-ULP-scale overlap; real models with multiple rounding operations can cross earlier) the same pair's measured depth exceeds the fixed `1e-4` and it stops being flagged touching, under the old fixed constant, while an epsilon scaled to the identical coordinates keeps it flagged.

The fix: `isTouching`'s default `eps` is now derived per-clash from `Clash.bounds` (the clash's own contact/overlap region — the only element-scale coordinates a bare `Clash` carries, since `ClashElement`'s bounds aren't available at this call site) as `max(TOUCHING_EPSILON, maxAbsCoord(bounds) * 2^-22)` — the same `2^-22` f32-ULP term used by `precisionFloor` in `engine-ts/narrow.ts` and `planeEps` in `contact/narrow-phase.ts`. Floored at `TOUCHING_EPSILON` itself (not the raw single-metre f32 floor those two use) so near the origin the new default is bit-for-bit identical to the old fixed constant — verified against the existing `analysis.test.ts` fixtures. An explicit `eps` argument is unchanged and still overrides the default entirely.

`TOUCHING_EPSILON` remains exported with its existing value and meaning (the near-origin/floor band); `isTouching`'s signature is unchanged.
