<!-- SPDX-License-Identifier: MPL-2.0 -->
# Actual representation fixture repair

Four owned files from reviewed source
`83d15fa4971f4dcbc69aef7890673ff27a560bf0`, relative to
`c227cd078434b7a46333b1111a367148fe2ce2ab`, are reproduced byte-for-byte.
They correct the direct Boolean chain's analytic representation expectation,
preserve separate real affine-generated strict V2 positive cases, and add bounded
failure-only endpoint coefficient diagnostics. No exact predicate, topology
identity, tolerance, ledger limit or required successful geometry result changes.

The actual source `4a85b7d6de` runtime chain still fails at
`rust/geometry-runtime/tests/plane_clip.rs:48` with status 7, because a stored
edge-interval endpoint does not exactly equal its topology vertex. That test and
its required volume-1 success remain unchanged. Source frame metadata cannot
repair the native represented-domain gap. No passing-refusal substitution or
skip is introduced. The new diagnostics must establish the exact failing source
coefficients before selecting a producer repair or a stronger mathematical proof.

Independent review found no new blocking defect in the scoped repair. Syntax
checking is source-only evidence. Corrected SDK/native/WASM numerical execution,
protocol round-trip and the full affine clipping chain remain UNRUN.
The earlier native job on `4a85b7` does not qualify these later edits.
