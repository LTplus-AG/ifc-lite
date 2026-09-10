# Shared appearance atlas extraction (#4381)

Finite-page composition delegates its existing canonical target discovery,
material preservation, chart layout and image binding to an internal sampler
interface. The page sampler retains the existing projection and alpha composition.
No public API or output format changes in this refactor.

The existing page tests exercise two objects, canonical IFC/PNG reopen, repeated
page application, high-frequency source texture preservation, transparency,
material fields and refusal budgets. Existing evaluated occurrence tests cover
the shared planner entry/exit added under #4404.

[The output comparison](page-output.json) calls actual pre-refactor F6 WASM and
the transfer-stack runtime containing this extraction with the same controlled
triangle, original RGB, finite red page and density. Their complete IFPA response
(metadata and encoded PNG, 2,547 bytes) is byte-identical. The after-runtime also
contains the separately planned transfer API; this check invokes only the existing
page API and is not a claim that transfer itself is enabled by this refactor.

The [native load comparison](native-load.json) uses immutable F6 base, extraction
and transfer-stack profiling binaries, interleaved on an otherwise idle machine
with five iterations per run. All 30 AC20 loads preserve mesh/vertex/triangle
counts and the ordered geometry fingerprint. No normal-load regression is
resolvable at the integer-millisecond phase precision. This does not measure
page/transfer authoring latency or a browser worker-pool speedup. The comparison
includes the transfer stack to avoid claiming it was measured on a pure
extraction runtime; each production checkpoint and binary hash is recorded.
