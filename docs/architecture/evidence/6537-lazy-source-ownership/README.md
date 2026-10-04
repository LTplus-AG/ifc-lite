# Shared ordinary IFC source ownership (#6537)

The canonical viewer no longer eagerly clones ordinary STEP shared source during resource-aware ZIP preparation. ZIP model extraction remains independently owned and its actual model bytes reach geometry and parser fallback, rather than the original archive. Owned conversion is deferred to an admitted ArrayBuffer-only consumer. Actual hosted O-S1 evidence now confirms the preparation copy is deferred to an admitted cache write; no speed or physical-memory improvement is claimed.

## Source and retained runs

The source review base is `c61932d4a9d85efe1b0f817a5274a115f0571ee3`. `source-freeze.json` pins all 16 intended code/test/docs/changeset files before this evidence-only addition. The private production loader SHA-256 is `40914bf1b55dfac115c9de29832bdbcd3dd2a982cb160a684a584554bb25db68`; baseline is `5b937abb035349e98e16119ca616e51d2e80b5cab663029a3a71342c120c99a7`. The qualification's uncommitted status records the historical checkpoint honestly; this PR subsequently commits that same source plus these receipts.

- Actual guarded root build: 62 tasks pass. Later fixes changed tests only.
- Plain root `pnpm typecheck`: 111 tasks pass, including its coverage audit of 3,354 test files across 57 workspace packages.
- Final restored viewer selections: 30 controls plus two separately selected server capability/supersession controls pass; zero skips. Parser ZIP selection: 34 pass. Entire IFCX package selection: 202 pass, zero skips.
- Private-loader baseline inverse: all eight observers remain registered and unchanged; one passes and seven fail with genuine `ERR_ASSERTION` results, zero loading failures/skips. Candidate source and observer hashes restore exactly, then all eight pass within the restored selection. The new private helper remains present during the revert, so missing imports are not the failure. ZIP archive/model aliasing and whole-source copying are observed directly.
- All nine source gates pass, including scoped deny-warnings lint, size, wiring, source assertions, API surface, README/generated-doc checks, 433 compiled doc samples (12 intentionally skipped) and diff check.

The first test-only BlobPart type error and two useless-spread lint warnings are retained alongside corrected final results; no receipt is rewritten to hide a failure. The package API snapshot was refreshed with the real tool after the root build and is unchanged. Matching docs and a generated parser/IFCX patch changeset accompany the source.

`qualification.json` names exact selected runs and limits. `runtime-tooling-receipt.json` hashes the actual built WASM, declarations and compiler consumed by controls. Local filesystem paths are historical producer identities, not portable runtime leases.

## Reproduce the behavior controls

Run the repository's frozen install and root build first, then use root Turbo scripts. The final viewer selection is the following union (the retained final run split off the last server entrypoint into its own two-control run):

```sh
TEST_PATTERN='useIfcCache.staleness|useIfcServer.(staleness|parquetSupportedStaleGuard)|useIfcLoader.(sabStreaming|sharedSource|federatedIdOffset|glbTextures|ifcxStaleGuard|placementIdentity)|arrayBufferForConsumer' pnpm test --filter=@ifc-lite/viewer --only --concurrency=1 --env-mode=loose
pnpm test --filter=@ifc-lite/parser --concurrency=1 --env-mode=loose -- ifczip
pnpm test --filter=@ifc-lite/ifcx --only --concurrency=1 --env-mode=loose
pnpm typecheck
```

For the inverse, preserve the candidate loader bytes in memory, replace only `apps/viewer/src/hooks/useIfcLoader.ts` with the baseline revision above, and select `useIfcLoader.(sabStreaming|sharedSource)` through the same root test command. Restore the saved loader in `finally` and verify its SHA and both observer SHAs before rerunning. The exact producer script, raw logs, exits, budgets and restoration record are retained in the packet; never leave the baseline source in place after the experiment.

## Read the raw packet safely

`raw-receipts.json.gz` is gzip-compressed JSON containing 60 immutable records: logical path, byte count, SHA-256 and base64 content. `receipt-manifest.json` pins both the gzip and decoded JSON plus each original payload. Decode as data with `gzip.decompress`, `json.loads` and strict `base64.b64decode(..., validate=True)`; verify byte counts and SHA-256 before reading. Logical paths must never be used as extraction destinations. No filesystem extractor is required. Duplicate production-source snapshots are excluded; the source itself and source freeze are available in this PR.

## Explicit limits and pending work

The mounted loader controls use canonical creator-produced STEP with real built WASM and real main-thread parser fallback. A declared-large file size selects shared acquisition without a 256 MiB test allocation. Parser-worker input is recorded before deliberate Node transport startup refusal; the real parser fallback then completes. These controls establish ownership and handoff, not actual browser worker transport, rendered output or large-model behavior.

Actual public O-S1 canonical-viewer allocation evidence is retained below. This instrumented allocation witness cannot be substituted for clean end-to-end timing or full scene/interactive/output qualification. The standalone SDK does not execute this viewer preparation path. Per-instance WASM storage remains; admitted cache writes and IFCX/GLB consumers may still allocate one owned copy. No GPU/full-authored-text/federation fidelity claim or fix for the reported 1,778 MiB Edge prepass failure is made. #6537 remains open.

## Actual public-model allocation witness

Hosted [run 37162551281](https://github.com/LTplus-AG/ifc-lite/actions/runs/37162551281) used source baseline `c61932d4a9d85efe1b0f817a5274a115f0571ee3`, this PR’s qualified production source `2feb6545b588e02d55d4d6b4d9afbe8be261452e`, and controller `32f8b91e0de20faa73a9f77f21b810f81d3646cf`. Exactly two serial fresh-process primary UI loads used the public O-S1 IFC. The actual original resident SAB source and native-copy ancestry were verified. Baseline makes one full preparation copy before default-pool prepass; candidate makes zero then, and one equal-size copy after geometry completion for an admitted cache write. Both cases make one total observed full-size copy. This proves deferral of the preparation allocation, not fewer total copies or lower physical peak memory.

The [canonical lossless evidence packet in #6782](https://github.com/LTplus-AG/ifc-lite/blob/2f952e499eef606c357ac2e8fc9f82ef24763f5d/docs/architecture/evidence/6537-viewer-source-allocation/README.md) holds all 16 raw hosted artifacts, original independent audit and root replay (40,585 passing checks each), source/build/fixture/actual Chrome and default-worker proofs, raw logs/requests/RSS, completed browser/process/server cleanups, offline replay and two unmodified screenshots. `hosted-allocation.json` pins the archive SHA and source/run identities. The evidence link binds to the immutable evidence commit; the reviewed archive bytes remain fixed.

**Strict full-appearance identity refused in BOTH cases: `flat/instance scene owner census mismatch`.** Both retain `geometryLoadState="opening"`, `metadataLoadState="idle"` and `interactiveReady=false`, despite legacy `loadState="complete"`. Full scene/interactive/output readiness is unqualified. Each preserves a setup-phase 404 console error with unknown URL. Each emitted WASM engine is bound to its own fresh build and served hashes, but their bytes differ; engine byte identity and timing equivalence are not claimed. No normal timing, speed, physical-memory win, full appearance/pixel/federation, all-model or 1,778 MB Edge-fix verdict follows from this witness.
