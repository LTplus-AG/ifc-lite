<!-- This Source Code Form is subject to the terms of the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

# Hosted default SDK worker comparison (#6537)

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

## Source builds and byte witnesses

Before the input snapshot, an owned symlink selects the exact version-qualified
installed pnpm CLI; the action launcher bytes and selection witness are retained.
Finite supported package paths are checked, with no broad directory search.
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
