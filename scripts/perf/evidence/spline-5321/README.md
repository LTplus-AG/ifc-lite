# Surface spline sample reuse (#5321)

Base: `074178f651c21dacbfbec33534701a59a7e81ace`. The candidate changes only
surface evaluation: reuse per-axis basis samples, discard exact-zero coefficients,
and preserve the order, product threshold and rational normalization of every
contributing term. Cache retention is bounded independently of input admission.

`native.jsonl` retains all five alternating fresh-process pairs per fixture.
Each invocation used the source-identical `perf_probe --cold --iters 1 --json
--fingerprint`; `fullLoadWallMs` includes file reading and the complete processing
return. The operating-system file cache was not purged. The machine was shared;
background load and individual samples are retained, rather than treating the
controls' variation as an optimization effect. No owned builds ran during this
cohort. `maxRssKiB` is `/usr/bin/time` whole-process high-water RSS, including
untimed fingerprinting and teardown. It is not browser memory.

The spline fixture improved in every paired full-load comparison. Control-model
full-load medians remained inside their observed run variation. Every ordered
mesh fingerprint, mesh/vertex/triangle count, CSG-failure count and dropped-
degenerate count matched across every native sample. This fingerprint does not
cover metadata text, textures or instancing records.

`wasm-base.json` and `wasm-candidate.json` compare the actual source-built WASM
prepass/batch boundary on three real fixtures at low, medium and high detail.
All nine results match exactly in mesh/vertex/triangle counts and SHA-256 over
ordered positions, normals, indices, colors, source IDs, types and origins.
This is a correctness comparison, not a worker-pool timing result. Both builds
used the pinned toolchain and `scripts/build-wasm.sh`; bindings were not edited.

Browser qualification is recorded separately; native improvements do not imply
browser readiness improvements. The original log-only browser smoke exposed a
baseline measurement gap: non-streaming upload after late renderer initialization
renders the model but emits no streaming-finalization log. Failed attempts are
retained locally; successful screenshots do not retroactively pass that cohort.

The source-matched browser observer is retained as `browser-observer.patch`
against `scripts/perf/browser-cold-ab.mts` at the base commit. Apply it only in a
measurement checkout. It checks the frozen bundles' audited renderer/store
exports, and fails if their bindings change. It measures `directReadyMs` from
file selection until metadata and geometry complete, store loading clears,
scene queues/finalization drain and a nonempty GPU frame completes without GPU
errors. The 20 ms polling boundary is quantized; it is not the stock harness's
`metadataRenderReadyMs`, which remains null.

Each sample launches a fresh Chrome process, loads the target first, and asserts
cross-origin isolation and SharedArrayBuffer availability. Both frozen viewers
were built with `pnpm turbo build --filter=@ifc-lite/viewer --force` after their
source WASM builds. Package and served WASM hashes matched on each side:

- Base: `9d605501ae119d068595537842fb710ed66cc2b236da1f2a3110dbd82ab0c97a`
- Candidate: `57704e12a8c9c3e3e958b4602b91078b801ee97c4b25528e623eaa65e5276cf5`

The browser is headed Chrome on Linux using **SwiftShader**, not hardware GPU.
The RSS metric sums the owned Chrome processes, so shared pages can be counted
more than once. Sampling every 250 ms includes startup through a fixed two-second
post-readiness tail; it can miss brief peaks and does not prove cache settlement.
The machine is shared and its OS file cache is uncontrolled. No owned builds ran
concurrently with the cohort. Failed preliminary log-observer runs were retained
locally and are not retroactively counted as successful direct-observer samples.

`browser.jsonl` preserves all fifty successful samples (five pairs on five
fixtures), including phase measurements, readiness proof, memory samples and
adapter identity. `browser-summary.json` derives medians and paired changes.
No browser failure or memory-sampler error occurred in this cohort. The spline
fixture's readiness median improved, but paired changes were mixed and its
geometry-streaming median was unchanged: **no demonstrated browser speedup**.
All control readiness and RSS medians stayed within their observed ranges;
this does not establish universal absence of regressions or a memory reduction.
The optimization is retained for the native result, with browser compatibility
qualified separately.

Functional follow-up: `functional-observer.patch` applies after the browser
observer patch and adds an untimed GPU pick, actual canvas click, and atomic
selection/metadata poll. Both builds passed on the spline fixture and Haus;
`functional.json` records the picked IDs and resolved IFC types. The paired
selection screenshots show visible properties and spatial hierarchy. The initial
scratch observer read selection separately after its wait and failed on both
builds; that failed attempt remains local and is not counted as a product pass.

Latest main `2e1357209` was merged after the frozen-build comparison. Its changes
do not touch the optimized Rust/WASM geometry path. Timing evidence remains
explicitly against the base above, not an unmeasured claim about rebuilt bundles.
