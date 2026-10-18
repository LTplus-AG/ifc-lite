<!-- SPDX-License-Identifier: MPL-2.0 -->
# Geometry platform foundation receipts

Parent: [implementation status](../../geometry-platform-foundation.md).
Baseline commit and complete candidate source fingerprints: [source-manifest.json](source-manifest.json).
The candidate is an uncommitted integration branch state, identified by those hashes.

[validation.json](validation.json) records commands, platform, fixture hashes and
artifact hashes. The final full workspace invocation exited successfully with
5,504 reported passing test invocations, zero failures and 47 existing ignored
invocations across 370 suite reports. These are aggregate cargo reports, not a
claim that every migrated capability has been tested. Its complete local log is
SHA-256 identified in the receipt.

Targeted receipts are retained for [real-model admission](retained-tests.txt)
(with the required-fixture gate enabled), [real subprocess execution](runtime-tests.txt),
[native CTest](native-ctest.txt), [WASM CTest](wasm-ctest.txt),
[Clippy](clippy.txt) and [Rust wasm32 compilation](rust-wasm-build.txt).
The original full run caught an ungated fixture read; the final source uses
`ifc_lite_testkit::fixture_bytes`, and the complete final run passed.

[default-path-perf.json](default-path-perf.json) contains raw interleaved base/branch
whole-worker-pool probe results, five iterations per invocation, in ABBA order
for each fixture. Mesh/vertex/triangle counts and ordered mesh FNV fingerprints
match across all samples for both real files. Timings are shared-host diagnostics;
no optimization or qualified latency non-regression is claimed. The probe selects
its best run; the phase summary states how those reported values were aggregated.
The default geometry path does not activate SMLib or retained admission.

No geometry, export, determinism or performance pins were changed. No browser
application integration, arm64 result, direct IFC-to-SMLib qualification, authored
BRep retention or USD/IFCX retained-geometry roundtrip is established by these receipts.
