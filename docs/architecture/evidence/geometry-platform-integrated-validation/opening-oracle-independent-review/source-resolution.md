<!-- SPDX-License-Identifier: MPL-2.0 -->
# Opening analytic-volume versus display-mesh comparison: resolution memo

Read-only. No production/test edits, tolerance/oracle changes, builds, jobs, SDK reruns, or fixture mutation. Root owns the contract decision and independent review. Current SDK/exact display values are from `/tmp/ifclite-sdk-outward-bab3-final.log`, lines 460, 469 and 507; these are actual assertions reached, not inferred successes. Root reports 6/6 native CTests and strict Clippy passed. Those results do not make these failed processing witnesses pass.

## Conclusion supported by the measurements

The SDK volume agrees with an independently derived source-coefficient analytic union volume within approximately 3–5e-15 m3. The existing exact-path closed display mesh has a measurably different volume. Consequently the failure is an actual output difference between two representations; it is not explained by parsing nominal decimal coefficients versus binary64, or by pre-rounding the fixture's aggregate endpoints. The current evidence does not establish an SDK opening placement/order error, and it does not establish which exact-path operation produced the display-volume displacement.

A closed triangle mesh is not an analytic source-volume oracle merely because its Boolean predicates use exact arithmetic. An assertion that it must agree with an analytic BRep to 1e-6 needs an additional preservation theorem or measured contract that is absent here and contradicted by this example. This does not authorize deleting the compatibility failure: geometric output deltas must remain disclosed and reviewed, and the default exact path remains permanent and unchanged.

## Independent binary-coefficient construction

Executable: `/tmp/ifclite-opening-binary-volume.py`; full exact rational results and input coefficient bits: `/tmp/ifclite-opening-binary-volume.json`. It reads the committed fixture directly and resolves solid -> rectangle profile -> 2D placement -> centre/direction and solid -> 3D placement -> origin/direction. It verifies every host/opening product placement is identity, the shared parent is identity, the sweep axes are +Z and the solid ref directions are +X. It derives the repeated mapping translation from the same binary64 0.2 token as the injected source, rather than parsing aggregate 1.7.

Numeric literals are parsed to Python binary64 and lifted individually into exact Fraction integers. The Rust STEP numeric leaf uses fast_float2<f64>; the script's recorded bits are expected correctly rounded IEEE binary64 interpretations of these elementary literals, not an executed capture from EntityDecoder. A final Rust test should additionally assert these source-decoder values/frames through actual canonical extraction; this script alone must not be described as runtime decoder qualification.

Canonical rectangle extraction divides each decoded dimension by 2; these values divide exactly in binary64. Canonical Axis2Placement normalizes X, projects it against normalized Z and renormalizes, then normalizes Z cross X. For this fixture the nonzero direction pairs (0.8,0.6) and (0.6,-0.8), and all axis directions, produce norm 1.0 at each binary64 normalization step; the script asserts that property. Their resulting finite matrix entries are retained as exact dyadic rationals for the independent geometry calculation.

The script performs exact rational convex polygon intersection and inclusion-exclusion of the reached opening footprints inside the host, with overlap height obtained by exact max/min of independently derived source-height expressions. It derives, rather than substitutes rounded aggregate literals:

- host volume: decoded(4) * decoded(0.2) * decoded(3) = 2.4000000000000001332267629550187848508358001708984375;
- A upper Z: decoded(0.3) + decoded(1.2) = 1.499999999999999944488848768742172978818416595458984375;
- C upper Z: decoded(0.6) + decoded(0.9) = exactly 1.5;
- second A centre: decoded(1.5) + decoded(0.2) = 1.700000000000000011102230246251565404236316680908203125.

It retains the tiny difference between A and C upper endpoints throughout; it does not merge their bands using an epsilon. No polygon, union volume or rounded endpoint is imported from the SDK or exact-path output. The exact rational calculation interprets the decoded dyadic affine matrices geometrically; it does not reproduce every intermediate rounded f64 matrix/vector multiplication in the engine. Thus it establishes an independent analytic reference, not bitwise equivalence to SDK construction or an interval-certified bound on every internal computation.

| Variant | Independent binary-coefficient analytic volume (m3) | Actual SDK volume (m3) | Exact display-mesh volume (m3) | Display minus SDK (m3) |
| --- | --- | --- | --- | --- |
| Original A,B,C | 2.0800000000000001094124790768091764 | 2.08000000000000318 | 2.08012553663746713 | 0.00012553663746395216 |
| A is Reference: B,C | 2.2075662500000001162753643368930019 | 2.20756625000000328 | 2.20756953284796831 | 0.000003282847965024871 |
| Repeated A,A+0.2X,B,C; two hosts | 4.1600000000000002188249581536183528 | 4.16000000000000547 | 4.16006829830238534 | 0.00006829830237986556 |

Independent nominal decimal reference remains 2.08 / 2.20756625 / 4.16. Moving to decoded binary coefficients changes those by roughly 1e-16, not the observed 1e-6–1e-4. This comparison rules out that particular explanation without proving where the exact display-route difference arose.

## What the source does establish about the exact route

`opening_witness::exact_volume` calls the complete `process_geometry` path and sums absolute signed volumes of selected closed triangle meshes. Closure proves incidence, not identity to the authored analytic boundary.

`rust/geometry/src/kernel/mesh_bridge.rs` explicitly converts f32 mesh positions to f64 and reconciles every coordinate to SNAP_GRID = 1/65536 in the caller's units before the exact kernel. Exact predicates then operate on the admitted reconciled geometry; they do not recover the original analytic coefficients. The source also contains a pre-existing opening execution regression (`openings/execute_tests.rs`, around 183–190) deriving its expected volume from the reconciled half-depth rather than the unsnapped authored box. This independently demonstrates that authored-volume equality is not a universal exact-display contract.

However, `process_geometry` may select original optimized routes, and the complete exact pipeline can perform multiple mesh conversions/reconciliations. No actual selected-route trace, generated vertex arrays, snap-centres, triangle plane equations, or intermediate volumes were captured in this investigation. Therefore this memo does NOT attribute the observed deltas specifically to the grid, nor claim that one hypothetical snap of the nominal source reproduces them. It also does not call the exact route incorrect: preserving its existing representation/compatibility semantics is a separate obligation.

## Defensible test and release obligations

1. Keep the original failed results, source identities and measured deltas immutable. Any later change of the witness contract must say why the former cross-representation volume assertion was unsupported; do not present a rerun under a changed oracle as a repair of production math.
2. Add independent source-analytic correctness tests for these authored rectangular/prismatic cases. Derive the footprints/overlap heights from actual canonical decoded source coefficients and transformations; use a separately implemented exact rational planar arrangement or reviewed analytic formula, with source-driven positive/refusal controls. Preserve the existing 1e-6 analytic error threshold. Do not use observed SDK numbers as expected constants or widen the threshold to encompass display deltas.
3. Retain existing operation-count, source/occurrence identity, sealed frame, source lifetime, manifold and Empty assertions. Volume alone cannot prove correct topology/placement. Complement with independent section/extent/centroid witnesses where they distinguish alternative wrong solids; the nominal per-stage volume table can localize cuts but is not a complete shape proof.
4. Separately preserve the default exact baseline through actual base-versus-branch execution of the identical ordinary `process_geometry` consumer, including mesh/triangle/byte identities and existing order-invariance tests. The unchanged exact default must not acquire the new analytic-BRep geometry by silent selection. Comparing the exact baseline to itself across the migration answers preservation; requiring every optional analytic representation to equal the baseline's display volume answers a different question.
5. Keep the cross-representation comparison as a disclosed compatibility measurement. Its failed equality is not a required analytic correctness assertion unless the product chooses exact display identity as a supported-mode contract. If exact identity is required for that mode, this remains a release blocker requiring an explicit compatibility/admission design; neither the independent analytic result nor a test rewrite waives it.
6. This is one small committed fixture, not authoring-tool or whole-platform qualification. #3641 self-overlap, final appearance/UV/layers/persistent faces/publication, real-model comparisons and performance remain independent residuals. Nothing here qualifies those requirements or the complete migration.

## Source bindings

Fixture SHA256: 21625ddf0c241cd7562cc2b2fa0ab49a0d2218ba32da37b2ef4d34f1143c146f.

Inspected root HEAD: ed13a69999745bde087bc898151a88e3f6aa6bb6. The measurement belongs to the root's bab3 job, not this later checkout HEAD. Specific source-file hashes are retained in the accompanying `source-hashes.json`; static source interpretation is separate from executed receipt identity.
