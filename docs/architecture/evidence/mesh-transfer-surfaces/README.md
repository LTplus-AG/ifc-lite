# Thin-wall, occluder and gap transfer controls (#4381)

Controlled synthetic acceptance for the F4 rules "opposite thin-wall surfaces
must not bleed into each other" and "missing regions stay unknown". Every
fixture is generated in-test with an identity registration; nothing here is a
real scan/IFC pair, and no registration accuracy is claimed. The controls prove
the classification rules over the real planner, apply, reopen and atlas path.

## Fixture

One `IfcWall` whose body is a 4 mm `IfcTriangulatedFaceSet` partition: front
face at y=0 facing -Y, back face at y=0.004 facing +Y, one square metre each,
styled solid green so any unknown texel is distinguishable from the scan. The
scan is a set of textured quads with constant UVs into a 3×1 red/blue/yellow
image. Settings: 64 texels/m, 20 mm maximum distance (five times the wall
thickness, so the opposite capture is always within reach), normal agreement
0.8, 1 mm ambiguity, 5 mm behind-surface limit.

Native tests: `rust/processing/src/appearance/transfer_acceptance_tests.rs`
(`cargo test -p ifc-lite-processing appearance::transfer --lib`). The same
fixtures run over the real WASM boundary in
`scripts/lib/wasm-mesh-transfer-surfaces-contract.mjs` (`pnpm test:wasm-contract`),
asserting the same coverage classification counts.

## Two-sided partition with a gap in the back capture

Front capture 1 mm in front of the front face over the whole face; back capture
1 mm behind the back face over x < 0.5 only.

| Count | Value |
| --- | ---: |
| samples (4 centroids + 8,420 interior texels) | 8,424 |
| observed | 6,340 |
| unknown: incompatible normal | 2,084 |
| unknown: distance / ambiguous / behind | 0 / 0 / 0 |
| observed area estimate | 1.504 m² of 2 m² |

Reopened through the production geometry pipeline and sampled from the emitted
atlas: front `(0.3, 0, 0.5)` and `(0.8, 0, 0.5)` are red, back `(0.3, 0.004, 0.5)`
is blue, and the uncaptured back region `(0.8, 0.004, 0.5)` is green. The red
front capture is only 5 mm from the back face, well inside the distance bound;
it is refused by its opposite normal, so no red bleeds onto the back face and
the prior appearance survives there.

## Slab in front of an uncaptured region, nothing behind the wall

Front capture with a gap over x in [0.4, 0.6]; a 2 mm yellow slab 6–8 mm in
front of that gap with both faces captured; no back capture at all.

| Count | Value |
| --- | ---: |
| samples | 8,424 |
| observed | 3,426 |
| unknown: incompatible normal | 4,212 |
| unknown: behind the surface | 748 |
| unknown: ambiguous (seam band only) | 38 |
| unknown: distance | 0 |
| observed area estimate | 0.813 m² |

Front gap `(0.5, 0, 0.5)` is green: the nearest scan surface is the slab's
wall-facing side, whose normal opposes the face, and nothing looks through it to
the far slab face. Back face `(0.2, 0.004, 0.5)` is green by normal; back face
under the slab `(0.5, 0.004, 0.5)` is green because the slab's wall-facing side
agrees with the back normal but lies 10 mm beyond the 4 mm wall, deeper than
the 5 mm behind-surface limit. Raising that limit to the full 20 mm distance
bound reports zero behind samples and paints that back texel yellow: this is
exactly the far-side bleed the limit exists to refuse. The 38 ambiguous samples
sit in the millimetre seam band where the front capture's edge and the slab are
equally near; none reaches a sampled interior point.

A one-sided yellow sheet 8 mm in front of the gap, facing the same way as the
wall, is observed as the wall's appearance at the 20 mm bound and is unknown by
distance at a 5 mm bound. Local nearest-surface matching cannot tell such a
sheet from the wall without scanner viewpoints; the distance bound is the
explicit control, and viewpoint adapters belong to F9.

## Why there is no separate occlusion classification

The observation is always the geometric-nearest source surface, so no other
source surface can lie between a target sample and its observation. Occlusion
therefore reduces to the nearest-first refusals above: an occluder facing the
wall is refused by normal, a near-tied pair is ambiguous, a farther one is
distance, and a same-facing surface beyond the face is refused by the explicit
behind-surface limit added here. `maxBehindMetres` is a required request field
bounded by `maxDistanceMetres`; coplanar captures are tolerated within f64
rounding under a zero limit (the existing centroid-only control runs with 0).

## Normal-load control

[native-load.json](native-load.json) records an interleaved base/branch/base/branch
`perf_probe` run on AC20-FZK-Haus (five iterations each) on a shared host, not
an idle machine. Best totals were 13/14 ms (base) and 13/13 ms (branch) with
identical mesh, vertex and triangle counts and one identical ordered geometry
fingerprint (`25ac885b6ff4ad00`) in every run. The changed sampler is not on the
load path; this only shows normal loading is unaffected. No transfer-throughput,
worker-pool or browser timing is claimed.

## Not verified here

No browser Preview/Apply/Undo/export run was made for these fixtures; the
existing [workspace](../scan-transfer-workspace/README.md) and
[full-target](../mesh-transfer-full-target/README.md) controls cover that path
with the unchanged Apply/export code. No real paired capture and no independent
held-out registration is involved; see
[what counts as validated](../../scan-alignment-workbench.md#what-counts-as-validated).
