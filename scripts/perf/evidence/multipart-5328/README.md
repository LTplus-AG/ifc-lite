# Multipart mapped instances: parked, not shipped (#5328)

The prototype extends the single-item mapped-instance path to separately keyed
source parts. It preserves the existing native API, adds an explicit multipart
entry point, updates the USD consumer to retain every part, and uses the same
source registry for WASM shard/orphan recovery. The full source and tests are
archived in `parked-candidate.patch`; **this PR applies no runtime change**.

Base: `52d30de0ae3fc8ef6322191bd1831483b93d485f`.
Candidate: `52da9ec0e0e44e2e727f3555f3c2e4daa0fdc43a` (the archived patch is the durable copy). All native binaries and browser WASM assets have recorded
hashes. The source-built package and served WASM hashes match, and the WASM files
postdate the Rust sources.

## Verdict and timing limits

No meaningful full-load benefit was qualified. The ordinary native flat path
remained byte-identical across five alternating pairs on seven fixtures. Its
Holter timing/RSS signal varied substantially. A predeclared ten-round rotating
A/A/candidate follow-up used the **same baseline binary** for A and B; the
candidate's time/RSS direction reversed from the initial cohort. Both cohorts
are retained. They establish neither a consistent causal regression nor a win.

Five alternating pairs through the actual native USD consumer also completed,
with deterministic output within each arm. Results were mixed despite smaller
serialized payloads on some fixtures. Unrelated Turbo/viewer work was observed
on the shared host during later rounds, so this is **not an otherwise-idle
performance qualification**. See `native-usd/contention-note.json`. No task-owned
build/test/oracle ran concurrently. OS file caches were uncontrolled in all
native cohorts; RSS includes untimed fingerprinting and teardown.

An attempted five-pair browser cohort was interrupted early when unrelated
Turbo/viewer work was observed again at launch. Its partial samples and
interrupt-induced failure remain in `browser-aborted/`; they do not establish
product failure, performance, or a successful browser cohort. There is no
qualified browser speed or memory claim. The two completed browser functional
screens are deliberately separate from performance evidence.

The experiment stops without shipping. Correctness coverage and smaller payloads
are insufficient to justify the new caches, eligibility checks and consumer
contract. A future attempt needs an otherwise-idle full-load comparison and a
new, evidence-backed reason to expect a win; it cannot reuse these timings as
qualification. This is an unqualified parked mechanism, not proof that every
possible multipart design is slower.

## Correctness and verification

- Fixture-backed `cargo test --workspace` and exact strict workspace clippy
  passed. The earlier workspace run without external fixtures is not used as
  corpus evidence. The real WASM contract run passed with one existing historical
  fingerprint skip; the source build and forced viewer build passed. Result
  excerpts and full-log hashes are in `verification.json`.
- Native flat counts, ordered mesh FNV, CSG failure counts and dropped-degenerate
  counts match in every initial and A/A-control sample. These hashes do not cover
  metadata, textures or instance records.
- Independent OpenUSD 26.8 composition compared Haus, Schependomlaan, Holter,
  architecture and school: complete mesh/triangle multiplicity, oriented
  triangles, transformed corner normals, element metadata, display color,
  opacity, purpose and orientation. Coordinates/normals use a stated tolerance;
  this is not byte identity or a bound-shader/texture oracle. The final measured
  binaries' output lengths/FNV match the independently inspected payloads in all
  five pairs (`usd-final-payload-identity.json`).
- The original lexical triangle sort produced false mismatches on near-tied
  transformed coordinates. Reports are retained. Spatial one-to-one matching
  fixed the observer; the long Holter run was interrupted without a verdict,
  then completed using an exact oriented/multiplicity-aware shortcut before the
  same spatial fallback. `oracle-reports.json` retains failures, interruption
  context and final results; it does not relabel the interrupted run as passing.
- `wasm-boundary.mjs` passes 28 actual prepass/batch cases, including a positive
  instanced-shard assertion at the repetition threshold, smaller-batch flat
  recovery, rotation, nonuniform scale, reused IDs/new source, geometry item IDs,
  indices, colors, world coordinates and normals. Every collection, mesh, API and
  prepass cache is freed. An earlier observer used the wrong IFNS coordinate
  frame; that failure is retained separately from the corrected product result.
- Actual browser GPU picking, click selection and entity type resolution pass on
  the eight-occurrence multipart fixture and Haus. The first sparse picking grid
  missed the tiny synthetic boxes on **both arms**; denser sampling passes on both.
  The initial failures, later passes and selected screenshots remain. This does
  not prove that the viewer chose instanced transport for that small fixture;
  the separate WASM boundary test proves the positive shard route. Chrome used
  SwiftShader, so no discrete-GPU or Firefox claim is made.

## Reproduce

Apply the archived candidate patch to a clean checkout of the base. The archived
Python drivers retain their as-run absolute paths: adjust checkout, binary and
output paths before use. Output directories must be new. Build the native flat
probe with `cargo build --profile profiling -p ifc-lite-processing --example perf_probe`
and the USD probe with `cargo build --profile profiling -p ifc-lite-export --example multipart_probe`.
The base USD probe uses the same archived example copied into the unmodified
base; only its linked library implementation differs. Native drivers keep every
sample and fail on invocation or identity errors.

Build WASM using `scripts/build-wasm.sh`, and invoke `wasm-boundary.mjs` with the
package directory and a new result path, adjusting its local fixture/decoder
imports. The browser observer is the bounded observer archived in
[the spline evidence](../spline-5321/README.md); add its functional observer patch
and then `dense-picking.patch` for the denser click screen. Use the two frozen
dist directories with `--iters 1 --headed`, the fixture paths, and separate
result directories. These screens are not five-pair performance runs.

Install the pinned `usd-core==26.8` Python package to run `usd-oracle.py` on the
base and candidate USDA files. It checks composed world geometry, not serializer
text equality. The interrupted observer is archived separately for auditability.
