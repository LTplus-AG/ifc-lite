---
"@ifc-lite/create": minor
---

Report a per-wall re-centring offset from `extractWallSegmentsForStorey`. A wall
axis derived from the body footprint (the fallback for walls with no `Axis`
representation) is the footprint's PCA **centroid**, which a meshed or asymmetric
footprint (more vertices on one face, a duplicate closing point, an attached
slab/beam) pulls a couple of cm off the true wall mid-axis. The result now
carries `centerings: ([dx, dy] | undefined)[]` (parallel to `segments`, metres) —
the world offset from each body-footprint axis to its geometric mid — so a
consumer (the `SpacePlateHandle`) can slide room corners onto the wall mid
without disturbing the arrangement. `undefined` for axis-rep / rect-profile walls
(well-defined axis). Exposes `footprintMidOffset` for testing.
