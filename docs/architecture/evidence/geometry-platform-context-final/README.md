<!-- SPDX-License-Identifier: MPL-2.0 -->
# Model-context layer: final qualification snapshot

The [manifest](source-manifest.json) and [source overlay](source-overlay.json)
freeze 288 inputs. Exactly two files differ from the
[prior snapshot](../geometry-platform-context-restored/): the new streaming
test's expected event boundaries and the restored public batch API descriptions.
Numerical production code is unchanged. The corrected snapshot's
[full native run](native-workspace.json) passes the workspace and all-target
Clippy checks. Earlier failed attempts remain recorded below.

The [fleet root typecheck](fleet-typecheck/receipt.json) also passes on PC against
clean committed checkpoint `c9ec560875`, with source unchanged before and after.
All 127 Turbo tasks succeed, and the audit includes all 4,248 test files across
67 packages. The exact fleet receipt and hash-verified output are retained;
this is type checking, not runtime or rendering qualification.

The [initial native attempt](native-workspace-initial.json) passes the corrected
streaming test, then stops at two obsolete positional-read allowances. The
[test-metadata correction](ratchet-correction.json) removes those entries and
freezes a separate manifest/overlay. Every production input remains unchanged;
earlier consumer receipts keep their original manifest. The positional-read,
function-size, module-size and styling-parity gates pass together before the
fresh full workspace rerun, which completes successfully. The immutable source
manifest's status describes its state when captured; the terminal run receipt
records the later result against that exact manifest.

The [baseline streaming comparison](streaming-baseline-comparison.json) proves
the actual five-event contract on both compiled libraries. The
[archived consumer and traces](streaming-baseline-artifacts.json) explain the
test correction; the prior failed workspace attempt remains recorded.

Fresh [WASM checks](wasm-consumer.json) pass 24 package tests and 223
matched-baseline contracts, with no skips. Public declaration shapes, raw ABI
and all five batch decoders match the baseline. Original API descriptions are
present in the regenerated bindings. The [installed Python consumer](python-consumer.json)
passes 49 tests without skips. The [USD consumer](usd-consumer.json) matches
seven actual exports, independent OpenUSD semantic comparisons and roundtrips;
these samples still provide no UV/texture export witness.

The [native artifact comparison](native-scene-artifact-identity.json) confirms
that rebuilt final-source libraries and both complete scene executables are
byte-identical to those used for the
[44 passing comparisons](../geometry-platform-context-restored/native-scenes/).
The harness sources also match. This is artifact continuity across a test and
API-prose correction, rather than an additional 44 runs. Positive layer cases
separately exercise the explicitly configured borrowed producer and the
[owned producer](owned-layer-comparison.json). The
[actual WASM layer consumer](layer-wasm/) compares both lazy and explicit
material-index setup against the baseline, including material provenance,
complete mesh getters and collection sidecars. These are synthetic layer
invariants, not a real-exporter or viewer-rendering qualification.

The [execution-record audit](execution-record-audit.json) independently checks
the recorded CSG census multiset and every nonmasked statistic in those 44 raw
scene cases, against both the baseline repeat and candidate. All match. Timing,
point-cache counters and the from-cache flag remain separately reported; census
multiset equality does not prove chronological or emitter-attributed effects.
The [audit archive](execution-record-audit-support.json) retains the exact audit
program and original comparison receipt; large raw records keep their stated
local accessibility limits.

The [positive fill witnesses](fill-witnesses/) add twelve synthetic annotation
cases across the four native modes. Structured records match both baseline and
repeat. Independent triangle-area/hole-intersection and placement checks cover
holes, millimetre units, horizontal/vertical placement, style wrappers and mixed
symbolic items. Fast-first appearance is asserted through its actual later
color-update event. These do not turn the real-model corpus's empty fill channel
into exporter evidence.

The [heavy Holter comparisons](heavy-scene/) separately match all four native
modes against candidate and independent baseline repeat, including actual
instances and deferred color output. This remains partial qualification: the
post-run raw/artifact rehash and supplemental execution-record audit were
refused by fleet admission and remain unrun. Its empty texture, layer and fill
channels provide no positive witnesses, and it establishes no performance verdict.

[Whole-worker-pool measurements](measurement-support.json) retain the actual
interleaved base/candidate timings, geometry fingerprints and native process
high-water marks. All six measured models retain identical geometry counts and
fingerprints; memory samples cover three. Fingerprints omit appearance and
occurrence channels. Timing remains unqualified on the shared host. The heavy
Holter model shows slower candidate execution and higher peak memory, an
unresolved risk requiring controlled profiling before cutover. No latency
non-regression or memory-improvement claim follows from these samples.

The [allocation diagnostic](allocation-diagnostic/) observes more requested
allocation traffic on Holter, matching retained result bytes and no increase in
peak requested live bytes. Whole-process RSS is still higher. This distinguishes
allocation traffic from retained payload size but does not identify allocation
sites, actual copy traffic or allocator behavior. Its
[support archive](allocation-diagnostic/support.json) includes the small raw
artifacts and ignored logs; instrumented timings provide no latency verdict.

[Supporting artifacts](consumer-support-artifacts.json) archive exact logs,
comparison sources and small manifests. Large runtimes, native libraries and
wheels retain their stated local accessibility limits.

Complete shared product/source execution, authenticated source bundles, full
effects ownership, resource admission, retained integration and platform,
consumer and performance qualification remain open. The exact arithmetic
engine remains permanent and default; this snapshot does not authorize cutover.
