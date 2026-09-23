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
