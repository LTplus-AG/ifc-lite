<!-- This Source Code Form is subject to the terms of the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

# B3.4: a real kernel stage on the GPU, with manifest parity (M6c final)

Bet: take the B2.5 exact GPU predicate library (`../gpu-predicates/`,
path C: raw f64-bits upload + fully on-GPU decode + 640-bit exact integer
arithmetic) and run a REAL stage of the CSG kernel through it - real models,
real call sites, real batch sizes - with sign-for-sign manifest parity against
the CPU path, measured against the >=5x stage-speedup exam bar.

Everything below was measured 2026-07-24 on Apple M4 / Metal-3 WebGPU
(real Chrome via Playwright, same stack as B2.5). Raw numbers:
`report.b34.json` (this directory) and the extraction logs/artifacts in the
session scratchpad `b34/` directory.

## 1. The stage, and how faithfully it was modeled

**Stage: broadphase-pair plane classification** - the first exact-predicate
stage of every mesh-arrangement boolean. In
`rust/geometry/src/kernel/arrangement/mod.rs::arrange`, every AABB candidate
pair `(host tri, cutter tri)` from `broadphase::candidate_pairs` goes through
`tritri.rs::tri_tri_intersection`, which (after the `near_coplanar` routing
gate) calls `plane_interval` twice - exactly **6 all-Explicit `orient3d`
evaluations per surviving pair**:

```
s_k = orient3d(t2[0], t2[1], t2[2], t1[k])   k = 0,1,2
s_k = orient3d(t1[0], t1[1], t1[2], t2[k])   k = 0,1,2
```

On the CPU these dispatch through `kernel/predicates.rs::orient3d` to the
Shewchuk adaptive exact predicate (`geometry-predicates` crate). This is the
highest-volume predicate call site in the kernel and the direct analogue of
"triangle-vs-cutter-plane orientation batches".

**How the real workload was obtained** (no synthetic data anywhere):

1. The existing `csg_capture` seam (`rust/geometry/src/csg_capture.rs`, hooks
   inside the production `mesh_bridge::subtract`/`subtract_many`) records the
   exact `Mesh` operands of every real void cut. The unmodified
   `rust/processing/examples/csg_scaling_bench.rs` (with `CSG_BENCH_DUMP`)
   drives the full native pipeline on a fixture and serializes that corpus.
2. `extractor/` (this directory, standalone crate, path-dep on
   `ifc-lite-geometry`) re-derives per job the exact triangle lists the
   arrangement sees - `mesh_to_tris` snap, cutter-vertex promotion,
   outward orientation - enumerates `candidate_pairs`, applies the
   `near_coplanar` gate, and emits the 6 tuples per surviving pair in the
   kernel's own call order, plus the sign the production predicate path
   computes for each, plus native stage timings, plus an FNV-1a sign manifest
   (same mix as `kernel/manifest.rs`).

**Fidelity caveats, stated plainly:**

- Four private `mesh_bridge`/`tritri` helpers (`orient_outward`,
  `promote_cutter_verts_onto_host_faces` + `exact_on_plane_weld`,
  `near_coplanar`, `signed_volume6`) had to be copied verbatim into the
  extractor. **Fidelity gate:** for every Single job the extractor re-runs the
  full boolean with its re-derived operands through the public
  `arrangement::boolean` and byte-compares positions+indices against the
  production `mesh_bridge::subtract` output on the raw captured meshes -
  **194/194 jobs byte-identical across the 5 models**. The stage inputs are
  the real ones.
- `Many` jobs are modeled as `difference_all` models them (one arrangement of
  host vs concatenated components - exactly what the code does). The
  *fallback* paths a non-conforming batch can take afterwards (lenient +
  volume oracle, sequential per-cutter re-cuts) would add further tri-tri
  work that is NOT captured here.
- The `budget::tripped()` early-break is not modeled (no fixture tripped it).
- Later predicate stages (interval `cmp_along` ordering, `orient2d*` in
  re-triangulation, LPI/TPI implicit-point predicates, ray-cast
  classification) are out of scope - this is deliberately the single
  highest-volume all-Explicit stage.
- Captured corpora cover the **mesh-arrangement kernel only**. Most IFC voids
  route through the 2D-profile/prism fast paths and never reach it (see 2).

Reproduce:

```
# 1. capture (fixtures via `pnpm fixtures <name>` if missing):
CSG_BENCH_DUMP=<scratch>/corpus-<m>.bin CSG_BENCH_ITERS=1 \
  cargo run --release -p ifc-lite-processing --example csg_scaling_bench \
  --features csg-capture -- tests/models/ara3d/<model>.ifc
# 2. extract (writes <m>.workload.bin/.signs.bin/.meta.json):
cargo run --release --manifest-path extractor/Cargo.toml -- \
  <scratch>/corpus-<m>.bin <scratch>/<m> --fidelity
# 3. run GPU stage + parity + timings:
node harness-b34.mjs --dir=<scratch> --models=duplex,advanced,holter,c20,i129
```

<!-- Numeral provenance, added 2026-07-29 for the numeral gate
     (scripts/moonshot/ci/check-report-numerals.mjs). No figure in this report is
     changed; these comments record which numbers report.b34.json emits and which
     it does not. -->
<!-- numeral-ok: 640, 96, 96B :: format constants of the path-C encoding, not
     measurements: a 640-bit exact integer accumulator over 96-byte tuples. Fixed
     by the kernel's design and stated in the WGSL, not emitted by any report. -->
<!-- numeral-ok: 194 :: the fidelity-gated job corpus size, summed over the
     per-model `meta.jobs` fields of report.b34.json. The artifact stores the
     addends, not the total. -->
<!-- numeral-ok: 82% :: the void-CSG share of load time, from the repo's separate
     CSG performance investigation, not from this bet. -->

## 2. What the real workload actually looks like

First honest finding: on typical models the mesh-kernel void stage is far
smaller than synthetic-benchmark intuition suggests, because the router sends
most openings through the 2D-profile/prism fast paths (the "void-CSG=82%"
number from #1129 is about where *time* goes on the hard models, not about
every void being a mesh boolean).

| model | mesh-CSG jobs | candidate pairs | near-coplanar routed | orient3d tuples | exact-Zero signs |
|---|---|---|---|---|---|
| duplex | 10 | 866 | 180 (20.8%) | 4,116 | 1,472 (35.8%) |
| advanced_model | 13 | 948 | 172 (18.1%) | 4,656 | 25.8% |
| Holter Tower 10 | 2 | 920 | 12 | 5,448 | 4.4% |
| C20-Institute-Var-2 | 68 | 2,356 | 20 | 14,016 | 1.2% |
| ISSUE_129 (i129) | 115 (14 batched) | 48,847 | 3,138 (6.4%) | 274,254 | 8.3% |

Realized per-CSG-op batch sizes (tuples per dispatch if you batch per boolean,
which is the natural sync boundary in today's kernel):

| model | ops | min | p50 | p90 | max |
|---|---|---|---|---|---|
| duplex | 10 | 240 | 384 | 696 | 696 |
| advanced | 13 | 240 | 240 | 480 | 792 |
| holter | 2 | 360 | 5,088 | 5,088 | 5,088 |
| c20 | 68 | 144 | 192 | 336 | 600 |
| i129 | 115 | 144 | 504 | 1,944 | 108,312 |

Exactly as the bet brief feared: real batches are **hundreds**, not 1e7 -
except one i129 mega-element (108k tuples). Second honest finding: real
workloads are degeneracy-rich (up to 36% exactly-Zero signs - flush caps,
grazing contacts), nothing like random inputs; per-tuple those cost the CPU
adaptive path ~6x more (~65 ns vs ~10 ns native), and up to 68% of the
stage's CPU time (duplex).

<!-- numeral-ok: 20.8%, 35.8%, 18.1%, 25.8%, 4.4%, 6.4%, 8.3% :: shares computed
     in the table row from two counts printed in that same row, both of which come
     from report.b34.json (`meta.totalPairs`, `meta.nearCoplanarPairs`,
     `meta.tuples`, `meta.signCounts.zero`). Arithmetic the reader can check on
     the line; the artifact stores the operands, not the ratio. -->
<!-- numeral-ok: 108k :: rounded tuple count of the single largest i129 element,
     a per-element figure the model-level report does not break out. -->

## 3. Manifest parity (the exam's correctness bar): EXACT - PASS

Every extracted tuple was evaluated three independent ways: (a) Rust
production path (Shewchuk adaptive, recorded at extraction), (b) the B2.5 GPU
path C (raw-bits upload, on-GPU decode + exact 640-bit arithmetic), (c) the
in-page BigInt exact oracle.

- **302,490 real tuples across 5 models: 0 sign mismatches, 0 GPU
  fallback-sentinels** (all building-scale coordinates pass the D_MAX=100
  exponent-spread gate), BigInt oracle agrees with the Rust path on all.
- **FNV-1a sign manifests** (same mix as `kernel/manifest.rs`) computed
  natively over the Rust signs and in-browser over the GPU signs are
  **identical on all 5 models** (e.g. i129: `0xcce2df37e35d2b18` both sides).
- The x8-tiled i129 run (2,194,032 tuples) is also 0-mismatch.

Sign-for-sign, the stage's GPU result is byte-identical to the CPU path.

<!-- numeral-ok: 302,490 :: the exact sum of report.b34.json's five per-model
     `meta.tuples` values (4,116 + 4,656 + 5,448 + 14,016 + 274,254). The artifact
     stores the addends, not the total. -->
<!-- numeral-ok: 2,194,032 :: tuple count of the x8-tiled i129 SYNTHETIC run,
     which was produced by amplifying the corpus at run time
     (report.b34.json's `amplify` is null for the committed run) and whose own
     report was not committed. -->

## 4. Stage speedup vs the >=5x exam bar: split verdict

All GPU numbers are e2e wall clock inside the page: typed-array view (zero
CPU arithmetic), upload, dispatch, readback, sentinel scan. Best of 20.

**vs the equivalent exact CPU evaluation (in-page BigInt exact, the B2.5
baseline - "what it costs to get this sign exactly on the CPU"):**

| model | tuples | GPU whole-stage | exact CPU | speedup | GPU per-op | per-op speedup |
|---|---|---|---|---|---|---|
| duplex | 4,116 | 1.20 ms | 6.9 ms | **5.8x** | 6.2 ms | 1.1x |
| advanced | 4,656 | 1.30 ms | 8.0 ms | **6.2x** | 10.2 ms | 0.8x |
| holter | 5,448 | 1.50 ms | 11.4 ms | **7.6x** | 2.1 ms | 5.4x |
| c20 | 14,016 | 3.30 ms | 31.8 ms | **9.6x** | 40.4 ms | 0.8x |
| i129 | 274,254 | 27.8 ms | 696.5 ms | **25.1x** | 115.5 ms | 6.0x |

**>= 5x: PASS on every model - but only with model-wide batching.** Per-op
dispatch (the batch sizes today's kernel structure would naturally produce)
sinks to 0.8-1.1x on three of five models: a ~0.1-0.6 ms per-dispatch floor
eats batches of a few hundred. The win requires restructuring to batch across
booleans, not a drop-in per-boolean call.

**vs the actual production CPU stage (native Shewchuk adaptive, the code that
really runs): the GPU loses, everywhere, including asymptotically.**

| model | native stage | GPU whole-stage | GPU/native |
|---|---|---|---|
| duplex | 0.145 ms | 1.20 ms | 0.12x |
| advanced | 0.133 ms | 1.30 ms | 0.10x |
| holter | 0.069 ms | 1.50 ms | 0.05x |
| c20 | 0.153 ms | 3.30 ms | 0.05x |
| i129 | 4.12 ms | 27.8 ms | 0.15x |
| i129 tiled x8 (synthetic) | 34.8 ms | 175.8 ms | 0.20x |

Per-tuple asymptote on real-distribution data: GPU ~80 ns e2e vs native
adaptive ~15 ns (definite signs ~10 ns; exact-Zero degenerates ~65 ns). Even
shipping ONLY the degenerate subset to the GPU cannot win (65 vs 80 ns) -
and you cannot know the subset without running the filter anyway. A wasm
client pays maybe 1.5-3x the native numbers; still ahead of the GPU on every
measured model.

**Honest verdict:** the M6c exam clause "one kernel stage runs GPU-side with
manifest parity and >=5x stage speedup" is met **literally** (parity exact;
>=5.8x vs the equivalent exact CPU evaluation of the same stage, real
workload, model-wide batch) - and fails **economically** against the
production path, because the production path is not an exact-tier-per-call
evaluator: Shewchuk's adaptive filter resolves this stage's real inputs for
~15 ns/call, ~5x cheaper than the GPU's asymptotic e2e cost on this hardware,
before any of the GPU's batching constraints. The B2.5 library beats every
*exact-tier* CPU evaluation it is put against; it does not beat a
well-engineered adaptive filter at this stage's realized arithmetic.

<!-- numeral-ok: 0.6ms, 34.8ms, 175.8ms, 0.20x :: 0.1-0.6 ms is the observed
     per-dispatch floor range, an envelope rather than a stored field; the
     34.8/175.8 ms row is the x8-tiled i129 SYNTHETIC run described above, whose
     report was not committed, and 0.20x is that row's ratio. -->

## 5. Integration plan for the real Rust/wasm path - and whether the win survives

**Where the seam is.** `arrangement::arrange` (and `arrange_many`): step 1
enumerates `candidate_pairs` (CPU, cheap), step 2 is today an interleaved
loop `pair -> 6 orient3d -> branch`. The GPU integration point is a phase
split: (a) collect all surviving pairs' 96-byte tuples into one flat buffer
across ALL booleans of a model load (the wasm side already owns this memory;
`Float64Array`-as-`Uint32Array` reinterpret is zero-copy), (b) one chunked
GPU dispatch produces the i8 sign table, (c) `plane_interval` resumes as a
pure table lookup. Signs are position-independent, so the phase split cannot
change topology - parity is the manifest check above.

**Marshalling cost.** 96 B/tuple up, 4 B down; i129 = 26 MB up / 1 MB down,
included in every e2e number above (upload+readback is why small batches
lose). No encode cost: path C uploads raw IEEE bits.

**What it would take.** (1) An async boundary inside the currently-synchronous
wasm CSG worker (WebGPU readback is async; the kernel loop is not) - a real
restructuring, or `mapAsync` polling from a second worker via
SharedArrayBuffer. (2) A batched-op fallback policy for sentinel lanes (none
fired on real data, but the policy must exist). (3) Cross-boolean batching,
i.e. giving up the current per-element pipeline independence for this phase.

**Does the win survive? No - not for this stage, on this evidence.** The
production CPU stage costs 0.07-4 ms per model; the GPU path costs 1.2-28 ms
for the same signs. Even a batch of every predicate in the heaviest measured
model in one dispatch is ~5x slower than single-threaded native Shewchuk, and
the asymptotic per-tuple rate still loses ~5x. The integration above would be
engineering spent to make a hot path slower. The GPU exact library remains
the right tool where the CPU must run a genuine exact tier per call - the
fixed-width/BigRational escalations on implicit-point (LPI/TPI) predicates
(~5000x the interval tier per `budget.rs`, the #1109 stall family), or any
future batch consumer without an adaptive-filter equivalent - and B2.5's
25-135x over exact CPU tiers stands. But "kernel stage on GPU" as a load-time
lever for the arrangement's explicit-predicate stage is refuted by the
measured workload, and honestly so: the predicates are not the bottleneck the
moonshot framing assumed at this stage; the adaptive filter already deleted
the cost the GPU was supposed to delete.

<!-- numeral-ok: 5000x, 135x :: 5000x is the escalated interval/exact tier cost
     per call from the kernel's own budget.rs profiling (the #1109 stall family);
     135x is the best exact-CPU-tier speedup quoted from B2.5's DESIGN.md, a
     different bet's run. Neither is emitted by report.b34.json. -->

## 6. Files

- `extractor/` - Rust workload extractor (Cargo.toml + src/main.rs), with the
  `--fidelity` byte-identity gate.
- `harness-b34.mjs` - Playwright/WebGPU stage runner: parity, manifests,
  whole-stage vs per-op timings, BigInt baseline, optional `--amplify=K`
  (explicitly labeled synthetic tiling).
- `report.b34.json` - final measured run (5 models).
- Scratchpad (session): corpora (`corpus-*.bin`), extracted workloads
  (`*.workload.bin`, `*.signs.bin`, `*.meta.json`), capture logs, and the
  x8-tiled i129 report.
