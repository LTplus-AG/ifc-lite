<!-- This Source Code Form is subject to the terms of the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

# Hosted default SDK worker comparison (#6537)

The CPU sampler waits for a measured monotonic deadline between readings;
an early timer wake never lowers the one-second floor. Every CPU admission
failure retains the raw readings collected so far, including counter/interval
provenance failures. Thresholds and terminal refusal remain unchanged.
The registered benchmark dispatch's `comparison_mode=cpu` runs three prospective
sampler controls without compiling or loading a model. Its results qualify the
sampler only, not an earlier refused cohort or any performance claim.

This prospective protocol compares the produced CPU geometry stream from public
`GeometryProcessor.processParallel`. It has no measured performance verdict.
The unchanged reviewed consumer times initialization through complete stream
drain, bounded output retention and processor disposal; identity hashing follows
that timer. File upload, byte conversion and fixture verification precede it.
It does not measure full viewer readiness, metadata completion, GPU upload,
rendered appearance, pixels or interactive FPS. Native attribution is deferred.
The existing [viewer protocol](INTERLEAVED.md) keeps its stricter appearance
guards and remains independent, including every earlier refusal.

Dispatch the registered Benchmark workflow at the reviewed harness revision:

```sh
gh workflow run benchmark.yml --ref REVIEWED_HARNESS_REF \
  -f comparison_mode=sdk -f base_ref=IMMUTABLE_BASE_40_HEX \
  -f candidate_ref=IMMUTABLE_CANDIDATE_40_HEX
```

The reusable `perf-sdk.yml` job validates distinct lowercase 40-hex refs before
either arm checkout. Explicit SDK mode cannot fall back to a viewer job when
refs are missing. Viewer remains the dispatch default; ordinary single-arm,
PR, schedule and push behavior is unchanged. No secrets are forwarded and the
SDK job has only `contents: read`. Cancellation supplies no completed verdict.

## Separate public #994 witness selector

The default `sdk_selector=public4` keeps the original four families, 56 samples
and 28 pairs exactly. Their completed or refused evidence remains unchanged.
An explicit `sdk_selector=public994` declares a separate prospective witness:
only the public IfcOpenShell #994 slab, two baseline A/A pairs followed by five
alternating A/B pairs, 14 fresh Chrome processes and seven pairs. Unknown or
empty selectors refuse before arm checkouts. The reusable workflow calls this
input `selector`; the registered Benchmark SDK route forwards `sdk_selector`.

```sh
gh workflow run benchmark.yml --ref REVIEWED_HARNESS_REF \
  -f comparison_mode=sdk -f sdk_selector=public994 \
  -f base_ref=IMMUTABLE_BASE_40_HEX -f candidate_ref=IMMUTABLE_CANDIDATE_40_HEX
```

The fixture-only download pins [the public IFC file](https://raw.githubusercontent.com/IfcOpenShell/files/9fc2267d7f1ff35284c5b0fc28cc97bff7ace8e7/994--slab--segfault--augmented.ifc)
at source commit `9fc2267d7f1ff35284c5b0fc28cc97bff7ace8e7`, exactly 189918 bytes,
SHA-256 `1d1cd11c57d80fe4f769a05db49cf1a96973b1af6cbee2d75ef541cfa3cb8fa0`.
A single bounded 180-second download refuses redirects, non-200 responses,
wrong header length, excess/short body or wrong SHA. Its terminal raw receipt
records URL, source commit, response URL/status/length, actual bytes/hash and
failure reason when available. Partial payloads are removed; there is no retry
or replacement. Successful file and receipt hashes are frozen before builds
and checked afterward and through cohort cleanup.

The same endpoint verifies the fetched bytes outside its timer, then uses the
unchanged default `processParallel` consumer. Cold initialization, stream drain,
retention and disposal remain timed; hashing follows. Default pool selection,
at least two actual workers, ownership census, exact produced CPU identity and
unnormalized diagnostics equality, A/A noise, resource limits and terminal
refusals all remain required. Terminal completion also requires the exact
ordered sample IDs, families, pair/slot numbers, kinds and arms, and exact planned
pair metadata for either selector; cross-cohort aggregation refuses. The witness's drain timeout is 180 seconds.
Its terminal report status is `complete-14-sample-public994-SDK-witness` and its
artifact prefix is `sdk-public994`; default evidence keeps `sdk-worker` and
`complete-56-sample-hosted-SDK-cohort`.

This selector has no measured verdict. It does not qualify private #6516
`processStreaming` regressions, native phase timings or full viewer appearance.

## Source builds and byte witnesses

Before the input snapshot, an owned symlink selects the exact version-qualified
pnpm CLI installed by npm into a fresh owned directory with scripts disabled.
The original action launcher/version, producing install command/exit, raw stdout
and stderr, package lock/integrity and selection hashes are retained. Exact
installed metadata and version must match; no action bootstrap layout is assumed.
Both source arms have frozen installs and new, separate Cargo target directories.
Root Turbo builds each SDK with `--force --concurrency=1 --env-mode=loose`, serially,
before either endpoint is bundled or timed. There is no prebuilt WASM route.
The source snapshot precedes compilation and checks literal Git object bytes,
actual workspace hashes, clean tracked state, source links and immutable heads.
The producing wrapper retains its exact command, actual exit, raw log/hash,
zero-cache task outcomes, cleanup and immediate post-build WASM size/hash.
That WASM must predate neither build start nor its served bundle witness.

Inventories pin every served asset, public fixture, actual Node/Chrome/compiler
executable, exact locked wasm-bindgen transform, observed linked library, conservative Rust sysroot library/source
tree, installed pnpm/Turbo/TypeScript and transitive automation/plugin package
file. The official wasm-bindgen release is prefetched before input freeze and
its archive/member hashes, PATH selection and exact locked version are checked
before/after each source build. wasm-opt is disabled in the canonical build.
Both arm plugin/tool package bytes must match. This is source-build
provenance, not a closed machine or Cargo-registry/linker/environment proof:
Cargo.lock's source checksums are recorded as tracked bytes, but downloaded
registry source files and all system tools are not independently inventoried.
Inventories are checked before/after each pair and after terminal refusal.

Browser observations must have qualified frozen-origin URLs and status 200.
After drain, each observed unique asset is refetched from that same immutable
origin with redirects refused; size, header length and SHA-256 must match.
Consumer, geometry-worker and WASM witnesses are mandatory. This establishes
observed requests plus immutable-origin refetch identity; it is not CDP capture
of original loaded worker response bodies. Servers preserve COOP/COEP and
no-store. No worker, shard, geometry feature or browser hardware override is used.

## Finite hosted resource and comparison contract

The exact manifest-backed Haus, ISSUE_129, Holter and O-S1 files are fixed.
Each family runs two baseline A/A pairs then five A/B pairs alternating
A/B, B/A, A/B, B/A, A/B: 56 fresh Chrome processes and first-file loads.
Actual hardware concurrency/device memory, default pool-start count and unique
contiguous worker IDs are recorded and must match within all family comparisons.
The consumer requires at least two workers; it does not assume eight or override
the default, which may choose two on a four-core hosted runner.

This Linux-only hosted contract requires 8 GiB initial available memory,
4 GiB live available memory and at most 5 GiB sampled summed owned-process RSS.
Three fresh aggregate `/proc/stat` intervals, each at least one second long,
must report CPU use at most 10% before and after every pair. Idle includes iowait;
duplicate guest counters are excluded. Exact integer admission avoids rounding
at the threshold. Observable compiler/test processes refuse; raw argv/env are
not exported. These gates do not imply that prior Windows/local resource gates
passed. RSS is sampled every 250 ms and may double-count shared pages or miss
short peaks; it establishes no physical peak or memory saving.

Drain timeouts remain Haus 180s, ISSUE_129 300s, Holter/O-S1 600s. Post-timing
hashing has 120s; browser/process/server cleanup has bounded 30s stages; cohort
and job ceilings are 90 and 150 minutes. Retention is bounded at 2 GiB,
250,000 events and 500,000 buffers. Raw console/network capture is bounded at
250,000 records/64 MiB per sample. Forced pipe closure refuses lossless-tail
qualification. PID/start-time fences restrict cleanup to witnessed descendants.

Output identity covers exact produced flat/template positions, real normal
bytes (including supported empty normals), indices, colors, origins and decoded
IFNS occurrence identity/transforms, plus the declared complete coordinate
channels. Unsupported shapes, UV/unknown channels, partial normals or missing
occurrences refuse. It establishes no unproduced text/texture, material-fidelity,
GPU or metadata identity. All 21 copied behavior controls exercise this protocol.

Known canonical semantic warning grammars are retained and classified with their
approximations/omissions disclosed. Unknown warnings, errors, retries, recovery,
panic, transport failure, skipped/hung elements or incomplete drain refuse.
Full untouched `complete.diagnostics` must match exactly, without sorting or
normalization, across A/A, A/B and the family's first baseline. Its cache
omissions and upper-bound census nondeterminism are not repaired by comparison;
different raw census values refuse. Matching diagnostics does not prove faithful
IFC geometry. An A/A elapsed difference above 10% also refuses. No sample is
retried, replaced or accepted after a refusal.

Every console/error/request event records its time and phase. An immutable
pre-teardown snapshot is saved before `browser.close`; cleanup events stay
separate so their later timestamps cannot establish an earlier failure cause.
SIGINT/SIGTERM enter bounded owned cleanup and retain refusal receipts; hard
runner termination can still prevent final writes and supplies no verdict.
Raw sample/build/resource/cleanup receipts and failures remain in `sdk-results`.
Only complete 14-sample families report their five descriptive paired deltas;
there is no automatic speed verdict or universal corpus claim. The explicit
client no-emit program, copied identity controls and new protocol/provenance/CPU
behavior tests are wired into the existing PR node-tests job.
