# Bundled main-first WASM initialization (#6537)

The archive retains the original SDK cohort artifacts, including both
fresh endpoint producers, all raw samples and pairs, source/build receipts,
resource observations, pre-teardown captures and cleanup. It also contains the
independent qualification and the checkout-path investigation. `manifest.json`
pins every member and the archive itself. No IFC model fixture is included.
The public locked wasm-bindgen supplier archive is pinned in the manifest and
original receipts, rather than duplicated here. It is the sole omitted SDK
artifact; tool and full-machine closure retain their original limitations.

The original SDK comparison is
[run 37149697842](https://github.com/LTplus-AG/ifc-lite/actions/runs/37149697842),
base `c61932d4a9d85efe1b0f817a5274a115f0571ee3` versus
`fcdc972d7df8f94651924c5879d0c2582b99c3ef`. Its fixed four-family cohort completed
with equal retained CPU-channel output, counts, coordinate information and full
diagnostics. Every browser sample observes one fewer WASM request. Elapsed results
are mixed; every pair and outlier remains in `sdk/report.json` and the independent
qualification. This is neither a general geometry-regression fix nor an all-model
speedup. Full viewer appearance and federation are outside this SDK route.

Both engines were freshly produced and served as frozen, but their binary code
and data differ despite equal captured Rust/build sources. The retained binaries
prove different absolute checkout filenames and shifted filename references.
They do not establish the cause of every changed instruction or elapsed delta.
Generated loader JavaScript and declarations agree. No engine byte-identity or
isolated compile-stage causal claim is made.

The separate revised source is
`9d59797fa2dc040c65d34d8f64361465ebda589c`. Its archived real Vite/generated-loader
VM proof checks success, same-response MIME fallback, delayed transient retry,
persistent original cause and fatal compilation, using an inventoried cached
official WASM artifact. It also checks module sharing, actual Rust API
configuration and handle free. This is functional evidence, not a fresh browser,
model, worker-pool or performance comparison.

The first official production-revert check failed because its new internal
export was absent after revert. That raw failure remains archived. The corrected
controls execute the baseline bridge and reach real request/body assertions;
the whole-production-revert oracle now observes assertion failures and verifies
restoration. Root typecheck, geometry test and scoped lint receipts are retained
under `validation/`. Earlier intermediate receipts are not pooled into timings.

The later historical comparison of that revised source,
[run 37152442255](https://github.com/LTplus-AG/ifc-lite/actions/runs/37152442255),
is complete and retained in the separate revision below. It does not qualify
the subsequently corrected warm-glue source.

To inspect, verify the archive SHA against `manifest.json`, then extract into a
fresh directory. Member byte sizes and SHA-256 values are listed in that
manifest. The archived audit scripts retain their original absolute capture
paths; a portable rerun must explicitly point them at the extracted `sdk/`
directory and retain any new audit output separately.


## Historical SDK and warm-glue revision

`historical-9d-sdk-and-warm-glue-revision.tar.gz` and
`revision-manifest.json` preserve the next evidence revision. The original
archive and original `manifest.json` remain byte-for-byte unchanged. The new
manifest describes 304 reconstructed members: 228 reside in the new archive,
and 76 reference exact identical bytes in named original archive members.
These references include unchanged endpoint and VM assets; no asset is inferred
from a source hash. The public wasm-bindgen supplier archive is retained in this
revision too. No IFC fixture is included.

The historical run compares base
`c61932d4a9d85efe1b0f817a5274a115f0571ee3` with
`9d59797fa2dc040c65d34d8f64361465ebda589c`, using controller
`4d47506a23e304ed4b772f7890e27e37843e8914`. All 56 fresh samples and 28 pairs
complete, including eight preceding A/A controls. CPU-channel identities and
full unnormalized diagnostics agree; the default runtime reports two workers
on four cores. The independent audit retains all five A/B deltas per family,
all outliers, raw resource intervals, producing receipts and cleanup witnesses.
Its median paired elapsed deltas are house −1.504%, CSG −0.936%, Holter −2.275%,
and architecture −0.076%. CSG includes both +0.869% and −9.793% pairs; the high
baseline value explains the latter calculation, not its physical cause.
Architecture is mixed. Nothing is removed or pooled with earlier runs.

The base engine hash is
`8bece54c2d089bbec7ff0ce6fc00aee96edc7bdefd70eea60b5ccb7f8b1046c9`;
the historical candidate engine hash is
`0830c2d293f1d215138d0553e3d00718ffba75c860daab27ba72dc080ed25c73`.
Captured Rust/config inputs agree, but binary code and data differ and contain
corresponding absolute checkout paths. That confound prevents isolating the
JavaScript mechanism from elapsed deltas. The historical cohort also did not
exercise a warmed public engine with an empty geometry module memo.

`warm-proof-v5-refused/warm-predecessor-oracle.*` records that real `9d`
compatibility defect using its retained emitted assets: public initialization
succeeds, then an offline Bridge starts two extra failed fetches, retains the
original transport cause, and fails a real no-new-fetch assertion.
`predecessor-9d-assets/` reconstructs all four assets that script consumed.
The same V5 directory separately retains the corrected-source VM attempt that
refused during `initSync` setup: a Node-realm options object failed generated
glue's plain-object check. Its async warmed-engine case passed; the failed sync
setup is not a passing control or a production failure.

`warm-proof-v6-complete/` retains all four emitted assets, entry files, proof
script, input freeze, guardian output and receipt for corrected source
`02112298d6cc690cda6fa3db712b524abc0f4712`. Eight fresh VM cases cover ordinary
public glue, async and `initSync` warmed engines followed by an offline Bridge,
cold shared initialization, same-response MIME fallback, transient retry,
persistent original failure and fatal invalid bytes. `initSync` options are now
created within the actual VM realm. Real Rust API configuration and free are
observed; acquisition, generated loader and API execution are not substituted.
The VM uses inventoried **cached official** WASM hash
`7d63d9bc94333f10c4044eac3f70bd86bf361b98659ff5e6cb1161def46f597b`.
This is correctness evidence, not a fresh performance build, Chrome/model run,
worker-pool comparison or full-viewer appearance proof.

`warm-fastpath-validation/` retains root Turbo's 617 geometry tests, 111-task
typecheck and 3351-file test-program audit, scoped lint/source/size/wiring gates,
and the whole-production-revert oracle: 22 passing controls become nine passes
and 13 real assertion failures, with restoration verified. Three production
files were reverted together, including the old evidence manifest; this is
aggregate test attribution, not separate per-file mutation proof.

The corrected-source comparison
[run 37155827255](https://github.com/LTplus-AG/ifc-lite/actions/runs/37155827255)
is pending at this revision, with controller `4d47506a23e304ed4b772f7890e27e37843e8914`,
base `c61932d4a9d85efe1b0f817a5274a115f0571ee3` and candidate
`02112298d6cc690cda6fa3db712b524abc0f4712`. Neither historical cohort nor the
functional VM proof supplies its verdict. There is no universal speed, RSS,
GPU/pixel, full metadata, Windows or eight-worker claim.

## Verification and reproduction

From a checkout containing both containers, reconstruct into a **new** directory:

```sh
python3 scripts/perf/evidence/bundled-wasm-init-6537/extract-revision.py /tmp/bundled-init-evidence
```

The extractor checks both container identities, the unchanged original manifest,
regular unique safe member paths, every stored/reference size and hash, and each
written file's hash. It never follows archive links or uses unrestricted tar
extraction. `revision-verification.json` records the actual full roundtrip.
The JSON manifests deliberately remain outside the containers to avoid circular
container hashes; their repository blobs pin the manifests themselves.

Inspect historical data under `historical-9d-sdk/artifacts/sdk-worker-37152442255-1/`
and derivations under `independent-9d-qualification/`. The original audit/proof
scripts are preserved verbatim, including their absolute capture paths. A rerun
must copy scripts into a separate scratch packet, explicitly update historical
input/output paths, and retain its new receipts separately. Never overwrite the
archived results. The predecessor script must use `predecessor-9d-assets/`, not
corrected assets. V6 reproduction needs the exact source commit, installed Vite
and plugins from its receipt, Node VM support, and the pinned cached official
runtime. Its `IFC_LITE_PROOF_ROOT` selects the source checkout; its packet directory
owns fresh emitted outputs. A new official WASM build may have a different hash
and is a new qualification, not reconstruction of this cached artifact.

A reviewer can verify the retained hashes and assertions without rerunning models.
Raw CPU arrays were not uploaded by the SDK protocol: their digests are observed
witnesses, not independently regenerated output. Runner-terminated source/tool
paths are producer receipts and cannot now be independently rehashed. The source,
installed-tool and full-machine closure limitations remain as recorded; extraction
adds no measurements or stronger fidelity claims.
