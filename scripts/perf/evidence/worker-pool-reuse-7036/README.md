# Persistent worker lifecycle controls (#7036)

**Functional prototype; performance acceptance held.** The experiment remains
opt-in. These controls exercise the real worker protocol, WASM engine, existing
idle boot scheduler and public parser against catalogued FZK and Snowdon IFCs.
They do not establish a rendered viewer federation, resident-memory ceiling,
first-visible improvement, or real-GPU end-to-end speedup. Issue #7036 stays open.

The tested production source is recorded in [source-freeze.json](source-freeze.json)
against main `62634ada5a9738590f0546ae4157ec04f8ab9aa3`, with exact changed-file
hashes and runtime hashes. The trace terminal-flush change on that main is
combined with the pool's epoch reset. Subsequent evidence/documentation writes
are not part of the browser execution. The browser was Linux HeadlessChrome153,
with cross-origin isolation; this is a CPU/WASM correctness run, not a GPU capture.

[Corrected](corrected.json) and [restored](restored.json) captures agree exactly
in their consumed source hashes, WASM hash and normalized output reports. The
initial boot created and admitted two workers, with none still initializing.
Each actual engine heap was 9,371,648 bytes, below the pinned-runtime 9 MiB
initial assumption. Returning a worker measures its non-shrinking WASM heap;
the additional 7 MiB per worker is an estimate, not measured resident memory.
The observed final idle booking was 112,721,920 bytes, within the 144 MiB booked
limit. Protocol controls separately exercise unknown/oversized heaps, delayed
initialization reservations, aggregate limits, expiry, hidden admission, errors,
abandonment, and abort during reset.

| Load epoch | Meshes | Triangles | Normalized output digest |
| --- | ---: | ---: | --- |
| FZK first and repeat | 317 | 33,356 | `16fcedb5` |
| Snowdon changed settings and fresh control | 17,380 | 477,826 | `49af97bd` |
| FZK defaults restored and fresh control | 317 | 33,356 | `16fcedb5` |

The executable oracle hashes positions, normals, indices, source colors,
transforms, material fields and the selected geometry-hash output, and compares
sorted entity IDs and coordinate information. Captures retain ID counts and
SHA256s; complete ID lists remain in the raw receipt. This is normalized payload
identity, not a cryptographic hash of every packed transport byte.
The parser completes a real pre-pass index handoff while its compiled-module
promise never settles; its metadata digest matches a fresh own-scan parser.
Cross-model IDs are checked through `FederationRegistry`, rather than manually
adding offsets. This does not replace full viewer federation acceptance.

Inverse and restored summaries record differences against the corrected capture
to avoid duplicating unchanged reports; full receipts are preserved separately.
The [inverse](inverse.json) restores only main's original fresh-disposal
controller. The same actual source/runtime oracle fails because repeated worker
creations increase from two to four; all six output digests still agree, and the
hidden-document control passes. [controller-restore.json](controller-restore.json)
records the changed and restored controller hashes. The restored run passes both
cases. This inverse detects persistent reuse, rather than a changed mock return.

Run from the repository root after fixtures and dependencies are available:

```sh
pnpm test --filter=@ifc-lite/geometry --filter=@ifc-lite/parser --filter=@ifc-lite/load-trace -- --maxWorkers=1
pnpm typecheck
pnpm exec playwright test worker-pool-reuse-7036 --project=viewer-e2e-ci --workers=1
```

The tests are wired into both existing viewer E2E project globs. The affected
geometry run passes 660 tests, including production-handler fault injection:
throwing memory introspection reports an unknown heap without skipping cleanup;
cache-clear/free failures still retire API and cached index state, report an
error and never acknowledge reusable state. Unchanged parser and tracing
controls pass 1,717 and 30 tests respectively, with eight absent-fixture skips.
The full root typecheck includes all 3,716 package/app/example test files.

Raw reports, failed diagnostic runs and command logs are preserved separately
under `/home/louistrue/.t3/artifacts/7036-persistent-pool-functional-20261008` and
`/tmp/7036-*`. The original fresh-overlap campaign remains separate in
[worker-warmup-7036](../worker-warmup-7036/README.md); its stalled/contaminated
records are not relabeled as persistent-pool acceptance.

Before performance admission, build both sides from recorded commits, retain
bundle manifests, and run idle, interleaved real-GPU cold/repeat/federated/cache
and large-model controls. Record first batch, first visible, total load,
normalized geometry identity, memory-pressure behavior, actual idle/peak memory,
and device health. Booked statistics and these functional controls are
insufficient to enable the experiment or close the issue.
