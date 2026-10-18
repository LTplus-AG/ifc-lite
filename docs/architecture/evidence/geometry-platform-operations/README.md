<!-- SPDX-License-Identifier: MPL-2.0 -->
# Owned constructors and ordered operation graphs

This layer adds owned lowering for tapered extrusion, revolution, swept disk,
swept area, polygonal face sets and faceted BReps. Together with the prior layer,
ten built-in leaf families now use shared production lower/evaluate seams.
The production solid/solid boolean path and the owned graph share the same
decoder-free exact-kernel numerical policy. Production source traversal, half-space
batching, host openings and assembly keep their existing behavior.

`source-manifest.json` identifies the uncommitted candidate, runtime and fixtures.
`validation.json` records commands and local raw-log hashes. The graph tests cover
ordered operations, CSG wrappers, role-specific custom dispatch, source disposal,
occurrence multiplicity, cycles, deep acyclic paths and shared DAGs. Diagnostics
retain semantic loss multiplicity with an explicit monotonic work bound. Tests
also preserve lazy unit discovery in production and refused-unit admission.

Real-file tests compare raw production processors against owned replay for the
committed wall/roof and bath fixtures and downloaded architectural models. They
compare geometry/frame bits and boolean diagnostics; the optional-fixture runs
must be checked for actual availability. Independent area, volume, cavity,
topology, normals and admission invariants supplement these compatibility checks.

`default-path-perf.json` records base/candidate/candidate/base whole-worker-pool
runs, five iterations per invocation, on the house, opening-heavy and heavy Holter
models. Geometry fingerprints include IDs/classes, positions, normals, indices,
RGBA, origins, bounds and transforms. They exclude text metadata, material
definitions, UVs, textures and instancing. Separate tests cover those contracts;
these fingerprints are not full-result byte identity. Shared-host timings remain
unqualified, without a latency, retained-BRep throughput or memory-win claim.

The graph remains opt-in and eagerly admits every dependency. Its fixed graph
and diagnostic-work bounds do not reproduce the legacy conditional/contextual
walk budgets and do not constrain payload or process memory. Evaluation of
algebraically unused dependencies remains eager. Numerical failure still lacks
an owned structured diagnostic result, and face/curve/source TLS
reports are not durable graph data. Product/mapping transforms, RTC publication,
appearance, opening plans, half-space/grouped-cut policy and BRep cutter voids
remain qualification gaps. Nine other leaf families still need owned lowering.
No SMLib production cutover or complete capability preservation follows from
these receipts. The [capability ledger](../../geometry-platform-capabilities.md)
remains open; earlier receipt directories retain their original source scope.
