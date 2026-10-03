# Shared ordinary IFC source ownership (#6537)

Source-only verdict: the canonical viewer no longer eagerly clones ordinary STEP shared source during resource-aware ZIP preparation. ZIP model extraction remains independently owned and its actual model bytes reach geometry and parser fallback, rather than the original archive. Owned conversion is deferred to an admitted ArrayBuffer-only consumer. No speed or physical-memory improvement is claimed; actual public-model browser proof remains pending.

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

Actual public O-S1 canonical-viewer allocation evidence remains pending. A prospective instrumented comparison must retain source/artifact provenance and native slice delegation, and cannot be substituted for clean end-to-end timing. The standalone SDK does not execute this viewer preparation path. Per-instance WASM storage remains; admitted cache writes and IFCX/GLB consumers may still allocate one owned copy. No GPU/full-authored-text/federation fidelity claim or fix for the reported 1,778 MiB Edge prepass failure is made. #6537 remains open.
