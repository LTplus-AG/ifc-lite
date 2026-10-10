# Federated appearance-source rebuilding (#6537 / #7021)

**Verdict: structural waste removed; end-to-end performance held.**
This draft fixes the remaining multi-model appearance list in the canonical
viewer hook. It is not a measured model-load speedup or peak-memory result.
The campaign root requested this qualified draft after the corrected cohort:
https://github.com/LTplus-AG/ifc-lite/issues/6537#issuecomment-6085363426.

Baseline main: `2382cf4124315f027b2d33c21c1751cee33c5081`.
Mounted baseline preparation: `d836deb651392b337d01bf791b67b56c1967652a`.
Validated implementation: `57a963c0c55ae9909bc326cc6c86ecfbd31d201d`.
Publication `5639fb3724ede20f29e144859fa50e5aa90ccf1f` adds documentation/evidence only.
Source, Git metadata and object alternate are on Linux; no shared checkout moved.

Normal main integration `70cae534e9ad8c5f143b2e4d59f5c8c834ac2b3e` includes
the shipped classification prerequisite #7361 and current main's sixteen viewer
test shards. All three appearance implementation/test file hashes are unchanged.
The local checks and runtime inventory below remain bound to the original
validated source; they do not qualify the new integrated runtime. Fresh hosted
CI results for the integrated source are recorded below. The declared experiment retains the exact base
`2382cf4124315f027b2d33c21c1751cee33c5081` and branch publication `5639fb37`
pins separately; its setup-only conditional reservation follows #7109/#6711.

Fresh integrated-source hosted Test run 37983892828 passed at `23ea207a`,
including all sixteen viewer shards, typecheck, lint, Node tests and both E2E
smoke jobs. The later [removal gate and measurement admission](gate-and-admission-20261010/README.md)
retain the actual Knip failure, independent root scope adjudication and failed
host-idle reading. Both phases explicitly released; no timing/model run began.
These documentation/artifact updates do not alter the qualified source bytes.

## Mechanism and preservation

Every store geometry-batch publication clones the models map to notify subscribers. The
old multi-model appearance hook consequently walked all accumulated and peer
meshes, built another list and created wrappers wherever ownership was unstamped.
The canonical hook now stamps producer objects through `stampModelIndex` and
retains one model-grouped list. Same-array appends insert only new references.
Immutable arrays, shrink, membership/order/index changes and content revisions
rebuild it. Zero/single-model transitions discard the federation cache.
The superseded appearance wrapper path is deleted.

An earlier-model append still moves the retained suffix to preserve grouped
order. This is counted as `viewer.appearanceSource.shiftedMeshes`: last-model
appends cost O(models + new), earlier appends O(models + suffix + new).
The visible cache's chronological GPU-upload prefix is a different contract.
The canonical loader streams store batches only for primary loads; federated
adds publish geometry atomically at completion. The fixed-batch replay below
therefore diagnoses the hook defect independently of actual worker-load timing.

## Actual reproduction and corrected checks

Both tests mount the real visible-federation hook before the appearance hook,
matching parent/child ownership order, then load actual Archicad FZK and
Autodesk Snowdon structural IFCs through the canonical loader/WASM. They replay
the produced meshes through the actual store append action in 16 fixed batches.
Every batch checks complete ordered geometry/appearance/frame data, owner indices
and borrowed CPU arrays. This is an untimed canonical-output replay, not an
independent geometry oracle or actual browser Worker-pool sample.

| Replayed model | Meshes | Appearance visits, base → branch | Wrapper copies, base → branch | Branch suffix moves |
| --- | ---: | ---: | ---: | ---: |
| FZK before retained Snowdon | 317 | 280,797 → 317 | 278,080 → 0 | 278,080 |
| Snowdon after retained FZK | 17,380 | 152,892 → 17,380 | 147,820 → 0 | 0 |

The baseline ran nine cases: six lifecycle controls passed and three efficiency
guards failed, with zero skips. The branch passed all 53 targeted viewer tests,
including all nine cases and canonical Bonsai CPU release. Renderer: 2,047
passes, zero failures, two skips. Final serial full root typecheck passed all
119 Turbo tasks, the 3,864-file test-program audit and frame-rig compiler.
Module-size, source-text assertion, test-wiring, touched oxlint and whitespace
gates passed. There are no Rust or published-package API changes.

Reproduce the mounted checks from the repo root, after official prerequisite
builds and fetched fixtures, using a coordinated heavy reservation:

```sh
CARGO_BUILD_JOBS=2 NODE_OPTIONS=--max-old-space-size=8192 pnpm build --filter=@ifc-lite/viewer --env-mode=loose --concurrency=1
TEST_PATTERN='useAppearanceSourceGeometry|useFederatedGeometry|useGeometryStreaming' NODE_OPTIONS=--max-old-space-size=8192 pnpm test --filter=@ifc-lite/viewer --env-mode=loose --concurrency=1
NODE_OPTIONS=--max-old-space-size=8192 taskset -c 0,1 pnpm test --filter=@ifc-lite/renderer --env-mode=loose --concurrency=1
```

Use allowed host CPUs for `taskset`; the recorded run used CPUs 0 and 1.
For serial root typecheck, temporarily set Turbo's configuration `concurrency`
to the **string** `"1"`, then run `pnpm typecheck` without appended flags and
restore the original bytes. The root script is compound: appended arguments
go to its final `tsc`, not its Turbo command. The exact successful temporary
configuration hashes and restoration are in the accepted retry receipt.
The earlier forwarding failure and numeric-config parser refusal are preserved
separately; neither is successful validation. No process was killed.

The renderer skips are the opt-in >2^24-vertex (~340 MB) allocation control
and actual WGSL/WebGPU readback unavailable in Node. Broad existing act/DOM
harness warnings remain in raw logs; the new appearance tests corrected their
act/teardown lifecycle without suppressing warnings.

## Identity and runtime binding

Fixture hashes, ordered geometry fingerprints and mesh/vertex/triangle counts
match across base and branch. The real-model JSON records hash IDs, material/
colour/frame fields and every positions/normals/indices/UV/appearance array;
owner indices are asserted separately. FZK has 57,706 vertices and 33,356
triangles; Snowdon has 1,005,848 vertices and 865,980 triangles.

The freshly source-built WASM and post-typecheck runtime share SHA-256
`f42d62ea549c36e69fe30eee14e619d26547a0cddfb6a27678ab39a0c995cc89`.
All 96,363 prepared files stayed unchanged across corrected tests. All 3,370
consumed viewer file URLs have frozen pre/post hashes. Baseline froze 3,338
of 3,342 consumed URLs; its four pnpm/corepack files only have post-run hashes.
Do not extend that baseline claim to a completely frozen dependency closure.

`artifact-manifest.json` binds the published raw compressed logs, result JSON
and consumed-file inventories. Complete prepared-tree inventories and V8
coverage remain in the local archive named there, with their original hashes.
The corrected cohort released reservation `380ecaee-b2cd-4d3e-b91a-9a0d09365160`
with zero remaining checkout processes and no servers/browsers started.

## Remaining qualification

Five interleaved base/branch native parse/geometry/total measurements are
NOT RUN. Native source is unchanged and those probes do not execute this hook;
they are controls, not attribution or browser acceptance. Actual worker-pool
federation A/B is NOT RUN. The existing fresh-browser cold rig loads one model
per sample and cannot qualify this class. A qualified journey must load the
same declared FZK/Snowdon federation via the canonical UI/loadFile path on both
sides, in a fresh tab, with actual worker count, readiness boundaries, output
identity and suffix movement recorded. Retain every failed/incomplete sample.

Focused physical GPU acceptance is unavailable. An unfocused run, skipped
criterion, missing fixture, local hardware advantage or mounted replay cannot
replace it. Future builds/full checks/timings need their own root reservation
and actual idle host conditions; the refused measurement grant is released. The draft
remains held, and the broad charter stays open.
