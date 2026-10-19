<!-- SPDX-License-Identifier: MPL-2.0 -->
# Opening volume diagnosis: d631 execution

Read-only source investigation. No Rust/SDK compilation, numerical SDK execution, submitted jobs, production edits, tolerance changes, or oracle changes. Fleet status at inspection: both ordinary hosts refused guard78. Existing job remains untouched.

## Established facts

The root reports d631 reaches the final unchanged 1e-6 comparison in three tests. All reached operation-count assertions pass: original three cuts, Reference-filtered two cuts, repeated mapped eight cuts. Current executed log has no actual SDK versus exact-oracle values. The values diagnostics added in f82669e1b0 have not run. Consequently the sign, magnitude and numerical source of the discrepancy remain unknown.

`opening_witness::exact_volume` executes `process_geometry`, selects every mesh with host Express ID 30, asserts undirected closure, and sums absolute signed triangle volumes. This is the existing complete exact-path mesh oracle, not an independent analytic-volume oracle. Its route may include original classification and fast paths. No observed difference from the analytic volume is established until its output is printed. Do not infer that an exact-predicate kernel makes all f32 display mesh volume computations analytic-exact, or that this explains the current failure.

The source fixture is `rust/processing/tests/fixtures/issue_2019_wall_two_overlapping_openings.ifc`. It is a committed hand-authored regression fixture. Wall is [0,4] x [0,0.2] x [0,3], nominal volume 2.4 m3. Product placements for host and all openings are identity. Opening A has profile centre (1.5,0.1), dimensions (1,0.4), unrotated, Z=[0.3,1.5]. B has centre (2,0.1), dimensions (1,0.4), profile basis (0.8,0.6), same Z. C has centre (1.8,0.1), dimensions (0.7,0.5), basis (0.6,-0.8), Z=[0.6,1.5]. Thus there are no survey coordinates, unit conversion declaration, parent-product translations, or host/product rotations in this fixture.

## Independent small fixture calculation

`/tmp/ifclite-opening-nominal-volume.py` uses Python Fraction only for convex planar clipping and inclusion-exclusion over the explicitly authored Z intervals. All input numbers are treated as nominal exact decimal rationals. It creates no mesh and calls no IFC engine. Profile direction pairs have exact nominal norm 1. The calculation is NOT proof of decoded binary64 normalization, constructed SDK BRep topology, runtime result, or exact mesh oracle.

| Variant | Nominal remaining volume | Nominal per-host cumulative cut volumes |
| --- | --- | --- |
| Original A,B,C | 52/25 = 2.08 | 2.16, 2.08, 2.08 |
| Reference A omitted: B,C | 1766053/800000 = 2.20756625 | 2.24, 2.20756625 |
| Repeated A,A+0.2X,B,C, two identical hosts | 104/25 = 4.16 total | each 2.16, 2.112, 2.08, 2.08 |

C removes no further nominal material after A+B in original/repeated; it does remove further material when A is omitted. This offers a useful stage-sensitive diagnostic. These rational values are a third comparison point, not a replacement oracle or authority to widen the 1e-6 predicate.

## Frame/order inspection

`retained_sweep::lower` keeps profile Position and solid Position outside SDK and moves profile coordinates by their first boundary point. It constructs source_from_evaluation = solid Position * profile Position * first-point translation * reciprocal unit scale. Region lowering subtracts that first point. The analytic rectangle parser keeps the profile placement separate, so it is not applied twice by this lowering.

Nominal initial evaluation-frame origins are host (0,0,0), A (1,-0.1,0.3), B (1.72,-0.36,0.3), C (1.39,0.23,0.6), with respective XY bases identity, identity, (0.8,0.6), (0.6,-0.8). Repeated mapped A's second occurrence adds +0.2 X. These are nominal expressions; 0.1/0.2/rotated origins are not all binary-exact. Host origin cancellation uses identical opposite operands and host basis is identity. There is no large-coordinate subtraction here.

`inner_voids_retained::retained_next` takes the current host result, walks original classified opening order, copies each distinct logical cutter occurrence, and issues Difference([host,right]). After acceptance it replaces current with that result. It resets the opening/cutter cursor for each host part. It does not union or concatenate cutters. Repeated host parts are independently cut four times each; exact observed count eight is consistent with this order.

`retained::boolean_operation` copies the left logical frame into the operation output, with a new output slot. `CommonRetainedRealization::dependency` supplies construction world_from_source, existing results' sealed original frame when equal, or explicit absolute PlacedResult otherwise. `RetainedDependency::input(Source)` multiplies world_from_source by the sealed source_from_evaluation. `evaluate_retained_boolean` computes inverse-left * right via column-major proper-rigid relative(), copies/transforms only the right, invokes Boolean on immutable copied inputs, and seals the output with the unchanged left frame. For this fixture left frame is host identity throughout; right transformation is consequently the authored evaluation frame, not compounded into previous cutter placement. The code inspected does not show an obvious reversed Difference, repeated product transform, unit scaling, or lost right occurrence translation.

This inspection establishes implementation intent and algebraic consistency, not actual executed matrices. Operation counts alone cannot prove the frames, source recipe extents, or numeric operands were correct.

## Minimal diagnostic needs

1. Run already-prepared source-bound final actual SDK versus exact mesh values for all three variants. Keep existing 1e-6 assertions intact. This discriminates a large geometric mismatch from a small integration/mesh-volume difference.
2. If those values do not immediately localize it, print actual original source ID/operation opening ordinal/cutter ordinal/left-right sealed frames, actual host and cutter primitive volumes, and every cumulative Difference volume before acceptance. Compare to nominal stage table without treating it as decoded-binary proof.
3. Include actual per-stage bounds or centroid only if needed to distinguish misplaced geometry from numerical volume evaluation. Keep diagnostics attached to actual sealed handles, not synthetic completion payloads.
4. If SDK agrees with nominal table but mesh oracle differs, inspect original exact-path selected classification/fast path and actual output triangles/source mesh instance handling, retaining the current oracle failure. If mesh oracle agrees and SDK differs, localize first differing construction/transform/Boolean stage before attributing a kernel defect.

The #3641 self-overlapping authored contour refusal is a separate established domain gap; nothing in this investigation changes its guard or regularization work. Exact arithmetic remains permanent/default.
