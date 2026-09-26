<!-- This Source Code Form is subject to the terms of the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

# Performance diagnosis kit

One place to answer "where does load time go, and what is the biggest lever?"
for both the **native** Rust pipeline (CLI/server/exporter) and the **WASM**
viewer path. The two run the *same* Rust code (`process_geometry` ->
`produce_element_meshes`), so native profiling finds the algorithmic hotspots
that also dominate in the browser; the WASM-only concerns (per-worker file
re-decode, no threads, memory bandwidth) are orchestration-level and are read
off the viewer's own telemetry (below).

## TL;DR

```bash
# per-phase parse-vs-geometry attribution across the heavy fixtures on disk:
scripts/perf/probe.sh --suite --census

# one fixture, more iterations, JSON for diffing runs:
scripts/perf/probe.sh tests/models/ara3d/schependomlaan.ifc --iters 5 --json > /tmp/a.json

# symbolized flamegraph (opens Firefox profiler) to see WHICH function:
scripts/perf/flame.sh tests/models/ara3d/schependomlaan.ifc
```

Fetch a fixture first if missing: `pnpm fixtures ara3d/schependomlaan.ifc`.

## Renderer colour override table (#6076, PR #6148)

A base-versus-branch browser run on a real Archicad architectural IFC, followed
by a 55-file federation of distinct real IFCs from the same test-model folder,
showed that the colour table removes the overlay draw and allocation cost in
both cases. The coloured images stayed visually consistent with the base.
This is a positive end-to-end verdict for those models; the original larger
55-model federation, alpha/emphasis/X-Ray states, and coloured streaming
still need their own acceptance run. The lesson is to measure both draw calls
and GPU-process private memory after applying a lens: the renderer's resident
geometry counter alone omits the allocation that dominated the old path.
See the [browser evidence](evidence/color-overrides-6148/README.md).

## Derived swept-disk metrics (#5754)

The length/bend calculations run only when an analytic description is
requested or serialized, outside normal mesh production. Verdict: default mesh
output is byte-identical (same ordered mesh hash on both revisions); a
default-load probe cannot measure this code's cost, and timing on a contested
host was unresolved. Measure opt-in analytic extraction on representative
swept-disk models separately from ordinary mesh loading.

## Opt-in swept-disk source descriptions (#5559)

The analytic reader runs only when called explicitly; normal mesh loading does
not traverse a directrix through this path. On AC20-FZK-Haus, five interleaved
base/feature pairs of `perf_probe --iters 5 --json --fingerprint` (base
`337aab4f4`, final feature stack) gave median parse/geometry/pipeline-total
times of 6/20/27 ms versus 7/22/29 ms. The base's pipeline-total samples
spanned 23–34 ms and the feature's 24–31 ms; the machine had other builds
running, so the small median difference is not evidence of a speed change.
Every run on both sides emitted 285 meshes, 35,940 vertices and 20,322
triangles with ordered mesh FNV-1a64 `c4d504b83ff698ea`.

Verdict: no mesh-output regression on this ordinary load, and no reliable
performance claim from the contested host. The opt-in extraction's own cost
needs a caller-level measurement on representative swept-disk models if it
becomes a frequent operation; the default pipeline cannot measure that cost.

## Raw-world RTC before f32 narrowing (#5698)

Every built-in raw-coordinate processor now removes the model RTC offset in
f64 through `process_in_rtc_frame`, and element walkers express that offset in
the item frame. Interleaved native probes on a loaded host showed no stable
timing change on AC20-FZK-Haus, ISSUE_129, ISSUE_098 or Holter: run-to-run
spread exceeded any base-versus-branch difference. Only the output of
`860_solid_stratum` changed across the fetched corpus: its national-grid TIN
now keeps its surveyed vertices instead of a 0.5 m f32 grid. The rebase costs
one extra first-vertex probe per raw-coordinate item on models with an RTC
offset; the f64 coordinate parse runs only for items that are actually rebased.
Measure A/B on a shared host by process CPU time and minima, not wall medians:
wall medians swung 10-20% between identical binaries under load.
Element-frame rebasing must go through the cached item path, keyed by its
offset: a bespoke path silently drops content dedup and instancing.

## LV95 site-local vertices and RTC frames (#5684)

Interleaved base-versus-branch native probes on AC20-FZK-Haus and ISSUE_129
showed no stable timing change across run orders. Both fixtures kept identical
mesh, vertex and triangle counts and ordered mesh fingerprints. A private bridge
IFC reproduced the intended geometry change: a site-local thin
member recovered faces lost when the old path subtracted the national-grid RTC
offset from already-f32 vertices. The lesson is to rebase early only when doing
so reduces object-space coordinate magnitude. For genuine raw-world coordinates
in millimetre files, the guarded subtraction must still precede f32 unit
scaling or a small face can quantize at national-grid magnitude. Items
processed in different RTC frames must receive placement before they are merged.

## LandXML credited-stream acceptance (#5050)

The native, generated-source acceptance harness is deliberately independent of
fixture downloads and browser scheduling:

```bash
cargo test --release --package ifc-lite-landxml \
  --test landxml_streaming_bench_5050 -- --ignored --nocapture
```

It generates and validates four production-shaped documents: a 90,000-point /
178,802-face TIN, 20,000 references to one high-valence vertex, 256 small
surfaces, and a TIN with one boundary plus 24 breaklines and 24 contours. Each
document also has 32 COGO points, so final non-terrain metadata delivery is
part of the measured completion boundary. Shape/count assertions and credited
queue invariants are acceptance checks; there are intentionally no time or
throughput thresholds.

`whole_ms` ends when `parse_landxml_document` returns its complete terrain and
plan document. `stream_ms` ends only after 64 KiB input chunks have received
credit, `finish_cursor` has run, and the final `Metadata::End` event has been
drained. Throughput uses source bytes over those respective walls. `queue_peak`
is the session's actual serialized transport queue (`queued_bytes`), which is
bounded by the **512 KiB** credit cap. It is not a memory measurement.

The three retained columns are portable semantic-payload proxies, not RSS or
allocator high-water marks: `retained_surface_or_event_proxy` is the larger of
the direct parser's largest serialized `LandXmlSurface` and a single streamed
surface payload; `retained_nonterrain_proxy` is the serialized plan document;
and `retained_document_proxy` is the complete direct document. They make the
important distinction between the tiny credited transport queue and retained
surface/document state without claiming portable process-memory precision.

Measured once on 2026-09-22 from `0830cc5b7fbc3139089fb67447fb6fd08bf38581`,
Rust `1.93.0-nightly`, Linux 6.6.87.1 WSL2 x86_64, release profile (warm build
and OS cache; timings are evidence, not a comparison baseline):

| Case | Input | Whole / stream ms | Whole / stream MiB/s | Surfaces / points / faces | Boundary / breakline / contour / COGO | Queue peak | Retained surface-or-event / non-terrain / document proxy |
|---|---:|---:|---:|---:|---:|---:|---:|
| large TIN | 6.28 MiB | 338.943 / 640.688 | 18.52 / 9.80 | 1 / 90,000 / 178,802 | 0 / 0 / 0 / 32 | 3.36 KiB (4 events) | 19.76 MiB / 8.00 KiB / 19.77 MiB |
| high-valence references | 876.20 KiB | 49.869 / 91.681 | 17.16 / 9.33 | 1 / 20,001 / 20,000 | 0 / 0 / 0 / 32 | 3.36 KiB (4 events) | 3.10 MiB / 8.00 KiB / 3.11 MiB |
| many surfaces | 52.13 KiB | 3.206 / 5.975 | 15.88 / 8.52 | 256 / 1,024 / 512 | 0 / 0 / 0 / 32 | 3.36 KiB (4 events) | 954 B / 8.00 KiB / 246.09 KiB |
| boundary/breakline/contour | 5.48 KiB | 0.280 / 0.472 | 19.09 / 11.34 | 1 / 4 / 2 | 1 / 24 / 24 / 32 | 5.92 KiB (4 events) | 19.71 KiB / 8.00 KiB / 28.21 KiB |

## Schema-specific crate-private registries (#4203, #4996)

Selecting generated per-schema attribute tables by the source file's schema
showed no measured parse, geometry or end-to-end regression on AC20-FZK-Haus
in an interleaved native base-vs-branch probe; the millisecond-quantized
movement stayed inside the base run's own spread, and mesh, vertex and
triangle counts plus the ordered mesh fingerprint were identical on both
revisions (figures in the PR's validation evidence). The lesson: generated
lookup tables can stay crate-private and be selected by the source schema
without changing emitted geometry or adding a measurable normal-load cost;
keep them out of the public Rust surface so this metadata correction does
not create a semver liability.

## Structural surface members through the face/surface machinery (#4206, #5026)

Measured exact merge-base `6500376a2` against the #5026 head on
AC20-FZK-Haus with the pinned toolchain and `profiling` profile, separate
build directories, five interleaved fresh-process base/branch pairs of
`perf_probe --iters 5 --json --fingerprint` on an otherwise-idle x86_64
Windows box. Median parse/geometry/pipeline-total were 8/8/16 ms (base,
total spread 16-17) and 8/8/17 ms (branch, spread 16-19); median full-call
wall 20.16 ms (base, spread 19.43-23.24) vs 19.78 ms (branch, spread
18.68-23.13). Every run on both revisions produced 285 meshes / 35,940
vertices / 19,456 triangles with ordered mesh FNV-1a64 `25ac885b6ff4ad00`.
Verdict: no observed regression and no speed claim; the fixture holds no
`IfcStructuralSurfaceMember`, so the new `IfcFaceSurface` route is never
entered here and this measures only the router's registration cost. Lesson:
a processor added to the built-in table is free until an element selects it.

## Full supported-schema `IfcType` parsing (#4203)

Extending the generated `IfcType::from_str` match from the canonical IFC4X3
catalog to the distinct names in every supported schema showed no parse or
end-to-end load regression on AC20-FZK-Haus in an interleaved native A/B probe.
The ordered mesh fingerprint and mesh, vertex, and triangle counts were
identical. This qualifies the ordinary IFC4 load path, not the cost of parsing
a legacy-only entity mix. The lesson is that generated exact-name match arms
can preserve the hot parser's performance, but a larger enum still needs an
end-to-end parser probe rather than an assumption based on lookup complexity.

## Bounded quick-metadata tree and reachable placement (#4689, #4743)

Measured exact merge-base `74ba2f24e664b37b96e871620fbfdbab653042f3`
against `9a6c88208079c032e577cfd0dfeb401a51ba6542` on AC20-FZK-Haus,
whose bytes matched the fixture manifest. Both native probes used the pinned
Rust toolchain, the `profiling` profile and separate build directories on
x86_64 Windows (Ryzen 9 9900X3D). Five fresh-process pairs per path ran
interleaved on an otherwise-idle machine, with balanced order from
`ab-order.mjs` seed 4743; the OS file cache was not purged.

The stock `perf_probe --iters 1 --json --fingerprint` leaves the bootstrap
disabled. Its base/branch median parse, geometry and pipeline-total times were
16/16, 19/19 and 35/36 ms; full-call wall time was 36.819/37.348 ms (+1.44%,
inside the base's 7.00% spread). That alone does not measure the new planner.
A source-identical probe on both revisions also called
`process_geometry_streaming_with_options_and_bootstrap` with
`emit_quick_metadata_bootstrap: true` and all other options at their defaults.
It used the stock probe's three preparatory index scans, timed callback entry
before cloning the bootstrap, and fingerprinted the clone and meshes after
the full-call timer stopped. Full-call time therefore includes the clone.

With the bootstrap enabled, median parse, geometry and pipeline-total times
were 16/17, 24/24 and 40/42 ms. Full-call wall time was 42.129/43.717 ms:
an observed **1.59 ms (+3.77%) opt-in cost**, just beyond the base's 3.71%
spread, not a no-regression result. Callback readiness was 13.066/14.562 ms
(+11.45%, inside the base's 13.52% spread). This small native cost is accepted
for bounded stack use and correct placement; it is not a browser worker-pool
speed claim or a scaling qualification for unusually large spatial graphs.

All 20 samples retained 285 meshes, 35,940 vertices and 19,456 triangles, with
ordered mesh FNV-1a64 `25ac885b6ff4ad00`. All ten enabled samples retained the
same 12-node, 12,600-byte serialized bootstrap, FNV-1a64 `2c58a0fc6e20ecec`.
The mesh hash covers the stock probe's payload fields, not text metadata,
material definitions, UVs, textures or instancing. The lesson: qualify the
enabled path as well as ordinary load, and report full-call cost separately
from callback readiness and the quantized pipeline timer. A disabled feature's
unchanged load time cannot establish that its new planning pass is free.

## Boolean operands dispatch from the router's built-in table (#4560)

The boolean operand resolver no longer keeps its own list of meshable operand
types; it falls through to the registry's `builtin_processor` for everything
except the two arms that carry `depth` and the cycle guard (`IfcCsgSolid`,
the boolean types). A processor is still built fresh per operand, exactly as
the hand-written arms did, so the only new work per operand is one `Rc`
allocation. Interleaved native A/B/A/B (5 rounds, `ab.sh`) on AC20-FZK-Haus
and ISSUE_129 resolved no phase beyond the base's own noise floor; mesh,
vertex and triangle counts were identical on every round of both fixtures
(285/35,940/19,456 and 1,402/218,365/132,657), as expected: neither corpus
authors a boolean operand of a type the old list lacked. Output changes only
where a boolean names such an operand — `IfcPolygonalFaceSet` cutters on the
Bonsai wall fixture now cut. This is a correctness fix, not a speedup. The
lesson: a second copy of a dispatch table drifts the moment a processor is
registered in one and not the other, and the drift is invisible because the
loser is an `UnsupportedOperand` record nobody reads; derive the operand set
from the registry instead of maintaining it.

## Consolidation keeps small openings on large faces (#4698, #4744)

Measured exact merge-base `2ecf0f096d0f2d6079963040d3293e5964785486`
against `c7e162d01dc8e59473d8e60ada081eb19abb79ef` on AC20-FZK-Haus and
ISSUE_129, both verified against the fixture manifest. The source-identical
stock `perf_probe` was built separately for each revision with the pinned Rust
toolchain and `profiling` profile on x86_64 Windows (Ryzen 9 9900X3D). Each
fixture ran five interleaved fresh-process pairs on an otherwise-idle machine,
using balanced order from `ab-order.mjs` seed 4744 and
`--iters 1 --json --fingerprint`. The three preparatory index scans and
uncontrolled OS file cache are the stock probe's warm-cache boundary.

Base/branch median milliseconds:

| Fixture | Parse | Geometry | Pipeline total | Full-call wall |
|---|---:|---:|---:|---:|
| AC20-FZK-Haus | 16 / 16 | 19 / 19 | 35 / 35 | 36.935 / 36.908 |
| ISSUE_129 | 33 / 32 | 889 / 896 | 924 / 929 | 932.971 / 938.638 |

AC20 retained 285 meshes, 35,940 vertices and 19,456 triangles in every run,
with ordered mesh FNV-1a64 `25ac885b6ff4ad00` on both revisions. ISSUE_129
retained 1,402 meshes but changed from 218,501 vertices / 132,815 triangles
to 219,858 / 135,749; its hash changed from `5dbcc345761e87a8` to
`9138d2efb799991e`, each stable across all five runs of that revision.
This is intentionally not a byte-identical comparison: the filter keeps real
opening rings that the plane-relative rule filled, and those rings also affect
seam conformance and subsequent triangulation. An untimed per-element hash
comparison found changes only in the seven hosts whose ISSUE_129 census rows
this PR repins: #7526, #32810, #59111, #139364, #149277, #244479 and #333923.
Their net increase is 2,934 triangles; every other element's mesh fingerprint
matched. These hashes cover the stock probe's ordered mesh payload, not text
metadata, material definitions, UVs, textures or instancing.

Verdict: no median timing move exceeded the base's measured spread on either fixture.
On ISSUE_129, geometry increased 0.79% against a 2.81% base spread, pipeline
total 0.54% against 3.03%, and full-call wall 0.61% against 3.01%, despite the
intentional output increase. This qualifies the observed native cost of a
correctness fix, not a like-for-like speedup, browser worker-pool result or
heavy-corpus performance verdict. The lesson: a relative speck filter can erase
real holes as its plane grows; constrain it by an absolute width as well, keep
the share guard for load-bearing thin reveal rings, and attribute changed mesh
bytes before interpreting a timing comparison.

## Qualified PDF dash expansion (#4406)

Dash expansion is reachable only from the explicit PDF annotation planner; it
does not enter ordinary IFC element production. An idle source-matched
AC20-FZK-Haus base/branch probe reported equal best parse, geometry and total
phases across five runs. Every run retained the same ordered mesh fingerprint,
mesh count and triangle count. The verdict is no ordinary-load regression, not
a PDF-page throughput claim. The lesson is to charge each dash advance and each
vertex crossed by a continuing run: a piece cap alone does not bound one long
on-run across attacker-controlled path vertices.

## Canonical appearance provenance (#4243)

Item-identified geometry now retains its canonical triangle-order identity at
WASM extraction. A production-browser worker-load A/B against the same Rust
runtime found a small median increase within the baseline run spread on the
public AC20-FZK-Haus fixture; this is not an optimization or a speedup claim.
All measured geometry/color/UV fingerprints and mesh/triangle counts matched.
The additional metadata reuses existing index arrays, with no extra geometry
buffer or transfer at extraction. Streaming fragments can retain an unsplit
source index array; that memory lifetime still requires explicit downstream
ownership and large-model qualification.

The measurement boundary was completed metadata plus geometry worker output,
with fresh Chromium processes and empty model caches. It did not measure
renderer readiness: the stock combined viewer-readiness experiment encountered
a baseline first-load viewport initialization race. Those failed samples were
retained and excluded, not treated as successful loads. The lesson is to name
and qualify the measured boundary before interpreting small load-time deltas.

## Authored metadata wire validation (#4441)

A shared early authoring guard now refuses free-text spellings that the host
mutation writer interprets as structural tokens. The source-matched idle native
AC20 A/B/A/B probe found matching normal-load geometry/total values and mesh
fingerprints, with quantized parse variation. This is a correctness fix, not a
worker-pool optimization. The lesson is to validate text at the shared authored
boundary using the consumer's exact whitespace/token rules; broad trimming can
both miss reserved inputs and reject ordinary Unicode names.
Evidence: `docs/architecture/evidence/authored-wire-tokens/native-load.json`.

## Manual scan registration foundation (#4381)

The correspondence solver is opt-in, bounded to 256 fitting and 256 held-out
points, with fixed-size matrix decompositions and explicit iteration limits.
It is reachable through the dedicated registration API only; parse, element mesh
production, styling and worker-load paths do not invoke it. An interleaved native
AC20-FZK-Haus base/branch probe found equal reported parse/geometry/total phase
medians and a full-wall median difference within the observed run spread. Every
ordered mesh fingerprint and mesh/vertex/triangle count matched. The verdict is
no material regression observed on that fixture, not a load optimization or a
browser worker-pool speed claim. See the [raw measurement](../../docs/architecture/evidence/scan-registration/native-load-perf.json).

Independent numerical review also ruled out the specialized small-matrix SVD:
its squared-matrix path lost thin but valid correspondence directions. The
bounded direct decomposition and two retained counterexamples prevent repeating
that failure. Small point-to-plane residuals remain no substitute for spatially
distributed check correspondences, as the CRAS evidence demonstrates.

## Incremental streaming finalize (#5358)

**Won.** `Scene.finalizeStreaming` / `finalizeStreamingAsync` used to dissolve
and rebuild every bucket in the scene, so each streamed federated add re-merged
and re-uploaded the whole federation (O(N²) over N models) and briefly held two
GPU copies of all of it. Finalize now rebuilds only the buckets that received
streamed meshes since the last finalize (plus any key already pending); the
in-place colour re-group it exists for only ever concerns those meshes.

Measured with the real `Scene` streaming + finalize + merge/quantize/upload code
over a byte-counting fake `GPUDevice` (10 synthetic models × 20,000 box pieces,
24 colours, two interleaved base/branch runs): the finalize of the 10th add went
from 645-819 ms to about 53 ms (flat per add; the 1st add is unchanged), and the
transient GPU bytes above the resident set during a finalize went from "the
whole federation" (155.7 MB at the 10th add) to "the new model" (15.6 MB). The
final resident bytes and batch counts are identical. The lesson is that the fake
device measures the CPU half exactly and the GPU half as bytes, not driver time.
The viewer's own federated "Add" currently takes the non-streaming
`appendToBatches` path and never reached this finalize, so the win is for
`@ifc-lite/renderer` hosts that stream federated models, and for any finalize
that runs with other models resident.

## Cross-batch shared shapes on the Parquet stream (#5407)

**Won, opt-in.** `?parquet_layout=shared-shapes&stream_shapes=cross-batch` on
`/parse/parquet-stream` sends each distinct shape once per stream instead of once
per batch. Across five fixtures (office, advanced_model, skolebygg, Holter
Tower, and a 342 MB architectural model), the client payload dropped 2.2x to
6.8x against the batch-local shared stream. It planned exactly the buffered
route's vertex rows, and landed 8-43% above the buffered route's bytes, which is
per-batch Parquet framing (17-132 batches). Peak server RSS stayed within
run-to-run noise of the batch-local stream, and every unchanged mode was
byte-identical to base.

Two lessons, both found by measuring rather than by design:

- **A content-hash registry alone is not enough.** Hash-only sharing across
  batches recovered only a third of the gap on the office model (841k vs 295k
  buffered vertices), because rotated repeats are not bit-identical. Stage 1
  (the rotation-aware collator) had to reach across batches too. That means
  keeping each instanced representation's first emitted mesh, not only
  collator templates: a representation seen once per batch is never collated
  inside any one batch.
- **The stream needs the baked basis before its first batch.** Without it,
  site-rotated models (skolebygg, advanced_model, DigitalHub) matched only the
  buffered route run with no basis, 2-5x worse. The frame is chosen before
  meshing, so `process_geometry_streaming_filtered_with_baked_basis` publishes it then.

## The native probe (`perf_probe`)

`rust/processing/examples/perf_probe.rs`, wrapped by `probe.sh`. It drains the
timings the pipeline already publishes (`ProcessingStats`) plus an isolated
`build_entity_index` scan, best-of-N, and prints the split:

```
  parse (pre-geometry)   <ms>   <%>     <- single-threaded; gates time-to-first-geometry
    - index-scan alone   <ms>   <%>     <- isolated build_entity_index (structural scan)
    - entity_scan        <ms>   <%>     <- scan loop + job/quick-metadata building
    - lookup/styles      <ms>   <%>     <- style/material/void resolution
    - preprocess         <ms>   <%>     <- unit scales, RTC detect, site transforms
  geometry               <ms>   <%>     <- rayon-parallel; CSG-dominated on heavy models
    - faceted-brep       <ms>   <%>     <- only with OBS=1 (features observability)
  brep point-cache       <hits>/<misses> (<rate>% memoized)
  csg census             <subtract/union/intersect/clip> | <operand-tris>
```

Flags: `--suite` (all catalogued heavy fixtures on disk), `--iters N`,
`--census` (CSG op distribution), `--json` (stdout; table stays on stderr),
`--fingerprint` (ordered mesh fingerprint, computed outside the timed interval),
`OBS=1` env (build with `observability` to fill `faceted_brep_time_ms`).

JSON `allWallMs` measures each complete `process_geometry` call, including final
metadata assembly after the pipeline's `totalMs` timer stops. Use its median
for full-load comparisons; `allTotalsMs` retains the narrower pipeline timer.
For a cold application load, pass `--cold --iters 1` with exactly one fixture
per process. This skips the isolated index scans and reports `fileReadMs` plus
`fullLoadWallMs` (file reading and the complete processing call);
`indexBuildMs` is `null`. Launch a new process for each sample. This does not
purge the operating system's file cache, so report that limitation explicitly.
With `--fingerprint`, `meshFingerprintsFnv1a64` records exact float bits and
ordered mesh identifiers, geometry, color, transforms and bounds. It does not
cover text metadata, material definitions, UV textures or instancing records;
validate those surfaces separately. Alternate base and branch runs in fresh
processes on an idle machine, with the same measurement harness on both sides.

Why `--profile profiling`: release-grade opt but keeps symbols and
`panic=unwind`, so `samply` gets a symbolized flamegraph and per-element
`catch_unwind` isolation still fires. (Plain `release` strips symbols;
`server-release` keeps unwind but strips.)

### Reading it

- **`parse` large** -> the win is in the **single-threaded** scan/decode path;
  it hits every model and is the time-to-first-geometry gate in the viewer.
- **`geometry` large** -> CSG/brep bound; check `csg census` operand-tris and the
  dead-end ledger below before touching the kernel.
- `index-scan alone` vs `entity_scan`: the gap is job-list + quick-metadata
  building layered on the raw scan.

## Flamegraph (`flame.sh`)

`samply record` on the profiling binary, opens the Firefox profiler. Click into
`ifc_lite_processing::...` for parse, `ifc_lite_geometry::kernel::...` for CSG.
Install once: `cargo install samply`.

## The WASM / viewer side

The browser can't use `std::time::Instant` (traps on wasm32), so parse phases
are timed in JS. Diagnose there with:

- **PostHog `ifc_model_loaded`** (project IFClite 199147): per-load milestones
  `file_read_ms, metadata_complete_ms, first_geometry_batch_ms,
  first_visible_geometry_ms, stream_complete_ms, total_elapsed_ms` + mesh/vert/tri
  counts. Emitted in `apps/viewer/src/hooks/useIfcLoader.ts`. This is the
  **user-facing** truth (time-to-first-paint, time-to-complete).
- **Console `[stream]` timeline** (`packages/geometry/src/geometry-parallel.ts`)
  and `[useIfc] TOTAL LOAD TIME` lines: `meta @`, `styles @`, `entity-index @`,
  worker-ready, first-batch. The CI benchmark scrapes these.
- **`?perfMem=1`** -> `memoryAccounting` `[mem-summary]` (JS heap, per-worker WASM
  heap, geometry bytes, transport bytes; `apps/viewer/src/lib/perf/memoryAccounting.ts`).
- **CI viewer benchmark** (`.github/workflows/benchmark.yml`, advisory): 6 load
  milestones vs `tests/benchmark/baseline.json`, flags >50% regressions on a PR.
  Run locally: `pnpm test:benchmark:viewer:ci`; check:
  `node scripts/check-benchmark-regression.js --advisory`.
- **`?geomWorkers=N`** and `window.__ifc_lite_viewer_store__` for live poking.

WASM-specific structural cost (not in the native probe, by design):
- **Per-worker file re-decode**: each of N geometry workers re-decodes the whole
  file + rebuilds its own entity index (`packages/geometry/src/worker-count.ts`),
  the ~5x peak-memory driver. Worker count is memory-clamped, not CPU-bound
  (`SMALL_FILE_MB=24`, >512 MB caps to 3-4). More workers do **not** speed up
  CSG (memory-bandwidth bound) - see ledger.
- **No wasm threads in the live path**: `init_thread_pool` exists only in the
  `threads` bundle (off by default); cross-worker parallelism is the JS pool.

## Large-model browser cold-load A/B (#3978)

`browser-cold-ab.sh` (wrapper) / `browser-cold-ab.mts` (harness) / `browser-ab-report.mjs`
(reporter). Preserves the mechanism behind #3921's private large-model
qualification (11 real IFC models, interleaved fresh-Chrome-process base/branch
pairs) as a repeatable, in-repo tool, instead of that mechanism living only as
one-off private scripts and a set of hardware-specific numbers pasted into a
PR description.

**DELIBERATELY MANUAL — NOT WIRED INTO CI.** `node scripts/check-test-wiring.mjs`
does not require a `package.json`/workflow entry for anything under
`scripts/perf/` (the same carve-out `ab.sh`/`probe.sh` already use); nothing
here runs on a PR. It launches a real, dedicated Chromium process per sample
and is meant to be pointed at private multi-hundred-MB models — neither
belongs on a shared runner. `.github/workflows/benchmark.yml` is the separate,
CI-wired, advisory-only sibling and is unaffected.

```bash
# public-fixture A/B, working tree only (repeatability check / no --base):
scripts/perf/browser-cold-ab.sh --skip-branch-build --iters 5

# real base-vs-branch (builds BASE in a throwaway git worktree):
scripts/perf/browser-cold-ab.sh --base origin/main --iters 5

# add private/large local models (never fetched or committed by this tool):
cp scripts/perf/browser-corpus.example.json scripts/perf/browser-corpus.local.json
# edit browser-corpus.local.json with real absolute paths, then:
scripts/perf/browser-cold-ab.sh --corpus scripts/perf/browser-corpus.local.json
```

**What "cold" means, precisely:** each sample gets a brand-new
`chromium.launch()` (no persistent profile) closed completely before the next
one starts — fresh WASM instantiation, fresh geometry-worker pool startup, and
an empty Cache API/localStorage/IndexedDB every time. It does **not** control
the OS file cache (same caveat #3921's own qualification recorded). Observed metadata/render readiness (`metadataRenderReadyMs`) and "first geometry" (`firstBatchWaitMs`/
`firstVisibleGeometryMs`) are reported as separate rows, never collapsed.

**Repeatability:** samples are interleaved (A, B, A, B, …), and the reporter
only calls a delta "real" once it clears the base side's own round-to-round
spread — the same noise-floor discipline as `ab-report.mjs` for the native
probe. Historical runs in the original PR used the app summary as TOTAL;
that metric could precede metadata completion and does not qualify the new
observed boundary. The existing CI `totalWallClockMs` remains unchanged and is
reported separately; no CI baseline is silently regenerated. Old records without
the new readiness field are refused by this manual reporter.

The observed boundary requires metadata, geometry, renderer-summary and canvas
signals, with finite timeout/error failures. It does not qualify search readiness,
cache-tail memory, properties, spatial paths, GPU picking or Firefox. Those issue
#3978 requirements remain follow-ups in this same harness, not implied coverage.
The retained mesh count alone is not geometry-buffer identity.

**Drift detection:** there is no committed golden here to drift silently —
every invocation prints its own base-vs-branch delta from that run's fresh
samples, so a stale number is never read as current. A `totalMeshes` change
between sides invalidates the timing comparison outright (printed as
`OUTPUT CHANGED`, matching `ab-report.mjs`'s fingerprint rule) rather than
being silently absorbed into "faster".

**Verified detection (harness self-test):** `--fault-inject-ms`/
`--fault-inject-side`/`--fault-inject-pattern` route-delay matching requests
(default `\.wasm(\?|$)`) on one interleaved side, to prove the harness
actually notices a regression rather than always reporting "within noise".
Historical request-delay runs verified the old metric's response to startup
delay; they do not validate the new readiness metric. Deterministic delayed-
metadata tests now exercise premature renderer summaries, delayed paint,
metadata failure and timeout refusal without launching a benchmark. A browser
functional smoke remains required before a new performance claim.

**Failures are archived, never silently retried:** a sample that does not
reach `streamCompleteMs` with `totalMeshes > 0` is recorded as failed (not
retried), with a screenshot + console log + error message written to
`scripts/perf/.browser-cold-ab-results/FAILED-*` (gitignored) — the equivalent
of #3921/#3975's preserved failure evidence for renderer SIGILLs.

**Raw cold IFC load only** — this drives the same `.ifc` parse/geometry path
the viewer's real cold load takes, never a prepared-format reload (Fragments/
XKT/XGF); that stays out of scope per the issue.

## Specialized harnesses (when the probe is too coarse)

| Tool | Question it answers |
|------|--------------------|
| `rust/processing/examples/csg_scaling_bench.rs` (`--features csg-capture`) | Does native CSG scale with cores? (captures + replays the void-cut corpus under 1/2/4/8 threads) |
| `rust/export/examples/glb_export_profile.rs` | GLB export phase split (index / mesh / assemble+serialize) + per-type triangle mass |
| `rust/export/examples/index_vs_scan.rs` | For a whole-file helper: how much is the entity index and how much is the scan? |
| `rust/csg-thread-bench/` (detached crate, `build.sh` + `web/serve.mjs`) | Threaded-WASM CSG: atomics tax + SharedArrayBuffer scaling in the browser |

## Five-avenue cold-load audit (#5331)

The [audit record](evidence/cold-load-audit-5331/README.md) compares current
source and prior shipped, rejected and parked levers. Sparse spline samples
qualified for native cold load; direct attribute construction was rejected;
multipart mapped parts remain unqualified after correctness verification.
Worker dependency packets have no demonstrated native counterpart, and broader
analytic opening coverage needs a new overlap algorithm rather than a weakened
guard. The opening census is diagnostic opportunity evidence, not saved time.
This audit does not claim five shipped wins or a browser speedup.

## Lever ledger (read before spiking)

### Retained processor registry ownership (#3987)

Built-in processor registrations share immutable setup while each router keeps its own failure state and custom replacement behavior. Own-layer native subset comparisons did not establish a meaningful full-load improvement; the cumulative result must not be attributed to this layer. Constructor profiles identify avoided setup work, not a throughput verdict. Keep custom processors and mutable diagnostics independent. Browser performance is a separate verdict; invalid Firefox cohorts and unrun follow-ups provide no supporting result.

### N-ary repair validation (#3925)

Rebase before measuring geometry. The old direct-router census converted survey
coordinates to f32 before subtracting an origin; its apparent covering regressions
were measurements of already-collapsed inputs. Disabling shared-corner protection
to satisfy that census regressed valid large-model cuts. A raw-first union also
improved a synthetic sweep while damaging those cuts. Both were discarded.

Preserve an accepted production union. For an unusable 3D opening union, try one
coordinate-preserving candidate before sequential subtraction. Roof chains need
their own actual-cut checks and a removed-volume upper bound from clean individual
trials; a bounding box alone cannot detect over-removal. Making every diagnostic
trial reject the original path also lost existing cuts and was discarded.

The census coordinate migration uses a reference generated on pre-regression
code, with one independently checked torn-to-closed row recorded separately.
Neither arbitrary golden updates nor local closure scores establish correctness.
Keep real loader output and independent solid measurements in the comparison.
See [the implementation and reference provenance](../../docs/architecture/nary-union-repair.md).
Correctness-only native and worker-pool full-load comparisons across eleven
models were broadly neutral in time and peak memory; the large target's browser
load improved. Five interleaved fresh-process pairs were used per model and
runtime, with OS file cache uncontrolled. Native geometry was byte-identical
except for the intended CSG129 repair. Browser geometry was identical except for
two already-open walls whose reference comparison is recorded in the linked
note. The performance-only stack is evaluated separately against this corrected
baseline. **Lesson:** qualify the browser's actual detail settings too; native
full-detail identity alone does not establish browser identity.

### Retained transient decoder ownership (#4000)

Reusable output buffers and a validated string projection avoid building discarded attribute trees; one-read metadata avoids filling a cache. Expired native decoder/item caches are disposed in a joined scope while trailing georeferencing runs. Own-layer native and actual Chrome worker-pool subset comparisons did not establish a meaningful full-load improvement. Keep the cumulative result separate, include the disposal join and trailing metadata in timing, and do not treat summed worker allocations as simultaneous memory. No isolated browser gain is established here; invalid Firefox cohorts and unrun follow-ups remain excluded.

### Cold-load validation notes

A geometry-complete event does not imply an interactive viewer: metadata,
renderer finalization and the store's loading state can finish later. Compare
fresh browser processes with the target file loaded first, and stop the load
timer only after all of these finish. Exercise GPU picking, visible property
sets and spatial hierarchy afterwards; exercise section generation on demand
and federation separately. Keep integrity extraction outside the timed interval.

Worker memory summaries can finish before renderer finalization. They are not
whole-load peak-memory measurements. Sample through full readiness and name the
metric precisely: summing Chrome process RSS can double-count shared pages.
Readiness polling quantizes short loads; capture the store's readiness event.
Coarse RSS sampling can miss short-lived peaks, so also inspect OS process
high-water marks and state whether they include browser startup.
Preserve failed loads alongside successful samples. Listen for renderer crashes
as well as JavaScript errors, and stop memory sampling on every exit path.

### Shipped wins
- **Firefox spatial-publication stall (#3983):** Chrome-only cold-load timing
  missed an engine-dependent entity-cache eviction cost. Georeference discovery
  runs through the property-set index during React rendering. Restarting a Map
  iterator for each eviction repeatedly traversed its deleted prefix in Firefox;
  a live eviction cursor preserves LRU ordering without restarting that walk.
  Prepare the source fingerprint and georeferencing in the parser worker and
  carry them with both store publications, so the first render does not rescan
  the source. Deferred-property parses must wait for their complete index before
  preparing georeferencing. **Lesson:** qualify Firefox as well as Chrome, record
  event-loop gaps and visible hierarchy readiness, and keep profiling runs apart
  from uninstrumented timing. A worker-complete event alone cannot establish that
  publishing its result leaves the UI responsive.
- **Native cold-load working set (#3967):** immutable schema classification replaces
  contended global caches; completed BREP signatures are shared within one
  immutable source; the geometry scan supplies ordered georeferencing candidates
  and discovery reads unrelated property sets without retaining them. Large
  sources with `u32` offsets build compact rows in fixed pages, then select a
  direct-address index only when its allocation fits within compact columns.
  Intermediate rows have a source-based budget; unusually dense record streams
  switch to hash coalescing so duplicate records cannot keep growing staging.
  Sparse IDs keep sorted columns; wider sources and supplied hash indexes retain
  their existing representation. Duplicate IDs still resolve to their last
  authored span. Interleaved fresh-process comparisons covered large MEP,
  architecture, sanitary, CSG, structural and bridge models from multiple
  exporters and schemas, including the small guard fixtures: all full-load
  medians improved and every ordered geometry fingerprint matched. Large-model
  peak RSS fell; small-model RSS ranges overlapped. **Lesson:** measure the
  whole call including final metadata and teardown, and measure the index's
  working set, not just time attributed to the scanner. Bounded parallel typed
  scan windows passed scanner parity but added too little end-to-end benefit
  to retain; the compact-index change produced the material gain.
- **CSG topology diagnostic (#3442): no measurable pipeline regression.** The
  record-not-gate closure audit adds a strict directed-edge hash sweep and only
  runs the hairline sweep when strict closure fails. On `140a6d854` versus the
  branch, five-iteration `perf_probe` runs were flat: FZK-Haus best total 9 ->
  9 ms (geometry 5 -> 4 ms), CSG-heavy ISSUE_129 605 -> 604 ms (geometry 586
  -> 586 ms). Mesh, vertex and triangle counts were identical; the only
  intentional observable delta was ISSUE_129's new CSG diagnostic count, 1 ->
  9. **Lesson:** keep this as an audit of the final result only — auditing
  batch intermediates turns diagnostic volume into workload-dependent noise.
- **Shared void-closure verdict (#4796): supported fixtures did not regress;
  heavy result inconclusive.**
  The closure decisions now reuse one directed-edge map, while strict-only
  callers still avoid the lazy hairline phase. Balanced base/branch runs covered
  FZK-Haus, CSG-heavy ISSUE_129, and the heavy Holter model; ordered geometry
  fingerprints and entity/mesh/triangle counts matched on every iteration.
  Controlled FZK-Haus and ISSUE_129 results were flat within mixed paired runs.
  Holter's pooled full-wall median was slightly slower and three of four paired
  medians favored base, while its spread remained too wide for a confident
  regression verdict; a small heavy-model overhead is therefore not excluded.
  This is a native full-load verdict, not a browser worker-pool or UI speedup
  claim. Unlike
  #3442's final-result diagnostic audit, this change shares the edge calculation
  between the existing closure decisions without making hairline analysis eager.
  Raw samples, executable and source hashes, environment, schedule, and metric
  semantics are in
  [`docs/architecture/evidence/closure-verdict/performance-controlled.json`](../../docs/architecture/evidence/closure-verdict/performance-controlled.json).
  The superseded uncontrolled run is retained beside it as `performance.json`.
- **Entity indexes built and never read** (`index_vs_scan.rs`): `relationships()`
  built a full parallel index and handed it to the decoder, but every decode in it
  is `decode_at_with_id` over the scanner's own spans and only `decode_by_id`
  consults an index. Dead work, deleted. `extract_georeferencing` does need one, so
  it gained a `_with_index` variant and `process_geometry` now passes the index it
  already holds instead of paying a second scan.
  Measured best-of-3 on the release fixtures, ms: O-S1-BWK 327 MB, parallel index
  58.3, bare type scan 180.8, `relationships()` 234.6, `extract_georeferencing()`
  337.6; schependomlaan 47 MB, 8.5 / 27.3 / 38.1 / 48.5. **Honest size: about 1% of
  a large conversion.** It is worth having because it is free and hits every model,
  not because it is big.
  **Lesson, and the reason this entry exists:** check which decode family a helper
  uses before handing it an index. The scan is the larger half of both of these, so
  "share the index" was never going to be the lever it looked like from a sampled
  profile that folded index build, scan and decode into one bucket.
  **Harness gap, third of its kind:** `probe.sh` cannot see this change at all.
  `ProcessingStats` closes its timers before the metadata block that calls
  georeferencing runs, so the probe table is flat on this diff by construction.
  A flat table here is a control, not a measurement.
- **CDT: kill the three O(T)-per-item scans**: ISSUE_129 geometry 1568 -> 646 ms
  (main, pre-seam-conform, is 979), **byte-identical output** on 8 fixtures incl.
  advanced_model (FNV over every mesh). The quality CDT — not the seam conform —
  was the whole cost of `consolidate_coplanar`; the conform's own work
  (`build_seam_map` + `conform_plans`) measures 20 of 1400 CDT cpu-ms, so
  "the conform is slow" was a mis-frame. What was actually slow, per instrumented
  slot-visit counts on one ISSUE_129 load:
  (1) `insert_steiner` renumbered every triangle to splice each Steiner point in
  below the super vertices — **1.07e9** index touches. Fixed by reserving the
  Steiner budget below the super verts at build time, so ids never move.
  (2) `edge_exists` re-scanned every triangle per constraint probe — **4.7e8**
  slot visits. Fixed by materialising the alive-edge set once in
  `enforce_constraints` and applying the flip delta (drop `u-w`, add `apex-q`).
  (3) `locate` was an O(T) canonical scan per inserted point — **2.2e8** slot
  visits. Fixed by a walk from the previous insertion that only answers when the
  triangle STRICTLY contains the point (unique ⇒ same answer as the scan) and
  falls back to the scan on the on-edge tie-break.
  Two smaller ones with the same shape: the encroachment test scanned all
  constraints per skinny candidate (5.9e7 disk tests -> a CSR grid built once per
  refinement), and `constraints` served millions of membership probes from a
  BTreeSet (now an FxHashSet mirror; the BTreeSet stays for the recovery ORDER,
  which is target-independence-critical).
  **Lesson:** all five are output-identical by construction, so the fix is
  measurement, not risk-taking — but only after instrumenting. The prior
  hypothesis chain (lazy seam map, x-range prune, CDT caching by clone/move) all
  measured ~zero because they targeted the 20 ms, not the 1400.
- **Fast first-geometry** (#1185): ship index/styles/first-wave at scan-complete;
  22s -> 11.8s wall to first paint. Overlap parse + geometry.
- **Faceted-brep dedup** (#1184) + **CartesianPoint cache hoist** (#1568/#1572):
  memoize shared points across parts; big win on steel/Tekla.
- **Local-frame f32 collapse** (#1114): per-element origin removes far-from-origin
  jitter and shrinks coordinates.
- **Worker right-sizing** (#1431): `SMALL_FILE_MB` 64->24, -21% peak, 0 regression.
- **Shared entity-index on the export/native path** (#1516/#1533, #1682): one sorted
  `(id,start,end)` binary-search buffer instead of per-worker FxHashMaps, where a
  *single* consumer builds it (streaming glTF export, binary-search columns). This
  shipped and is a real win; it is NOT the viewer huge-file case below (see dead ends).
- **Vertex weld at faceted-brep source** (#1562): closes the volume-metric gap.
- **Incremental affinity publication** (#4051, PR #4052): publish each existing bulk job
  chunk as soon as that chunk's routing keys are ready, keeping the shared decoder/signature
  memo, first wave, chunk boundaries and exact job order, so routing overlaps geometry instead
  of preceding it. Chrome, five interleaved fresh-process pairs per model: equal-model geomean
  readiness **-2.03%** over five models; large MEP **-9.8%** readiness and **-13.3%** geometry
  for **+3.4%** sampled physical bytes; the other four models moved at most 1.4% either way.
  No native or Firefox gain is established, and the memory cost is real, so this is a targeted
  readiness tradeoff. **Lesson, and the reason this entry exists:** the intended "combined"
  map-cache build never recompiled. Timestamp-preserving source restoration let Cargo reuse
  the affinity-only artifact, and forced Turbo execution plus matching bundled hashes did NOT
  catch it; the build log reported no crate compilation. After restoring a variant, force
  mtimes forward or build into a fresh output directory, and read the log for crate
  compilation. Full per-model table:
  `git show 4fbbe8dd5:scripts/perf/evidence/affinity-publication-2026-09-06/results.json`.
- **Retained cold-load stack** (#3985, #3987, #3993, #4000, #4001, #4003, PR #4008): the
  combined native full-load result is a geomean ratio of **0.845** wall and **0.987** max RSS
  over the fixed 11-model corpus, 5 interleaved fresh-process pairs each. **Read the cohort
  size before the ratio here.** The isolated layers ran on 2 or 3 models, not 11 (A, B and C
  on small-Haus + CSG129; D adds CSG177; E is small-Haus + CSG177), so layer E being SLOWER
  at a 1.036 wall geomean is a two-model statement, not a corpus one; the standalone
  ownership subset was slower too. Chrome, also 11 models x 5 pairs: **0.713** full-readiness
  geomean and lower sampled memory (0.904 RSS), but geometry completion slower on several
  models (1.015 geomean) and small-Haus readiness regressed in every pair (1.138). The
  original Firefox cohort is invalid under its own memory-sampling rule. **Lesson:** a good
  combined number licenses no per-layer percentage and does not erase a standalone cost;
  aggregate by median paired ratio then equal-model geomean, and never multiply separate
  layer ratios together.
  Full bundle: `git show 4fbbe8dd5:scripts/perf/evidence/retained-cold-load-2026-09-06/summaries.jsonl`.
- **Server JSON `float_roundtrip`** (#4064, PR #4065): correctness, not perf. The server's
  cached JSON deserialization moved a finite Haus northing and its transform entry by one
  float step; enabling serde_json's `float_roundtrip` preserves both with no tolerance or
  geometry change. The bounded fresh-process HTTP screen kept exact cold geometry and
  data-model bytes and corrected replay parity. **It claims neither a gain nor neutrality**:
  one pair per fixture is not performance qualification, and a processing-probe gain never
  extrapolates to the shipping HTTP artifact. Screen:
  `git show 4fbbe8dd5:scripts/perf/evidence/server-json-roundtrip-4064/screen.json`.
- **Y-up winding correction** (#4056, PR #4058): correctness, no throughput claim. **The
  IFC-to-viewer map `(x, y, z) -> (x, z, -y)` preserves orientation**, so the flat binding's
  extra triangle reversal was wrong; removing it aligns flat winding with transformed normals
  and the native/IFNS route, and a viewer geometry-output revision stops stale cached winding
  from surviving the fix. Simplification and native Y-up export conversion must use that same
  orientation-preserving convention. Canonical native geometry and its determinism manifests
  are unchanged; converted flat indices intentionally differ. A real WASM boundary contract
  pins it: it fails on the old runtime and passes on the correction. **Lesson:** a canonical
  geometry fingerprint cannot certify downstream coordinate conversion, and adaptive batch
  boundaries can expose a route-specific defect by moving otherwise identical entities between
  flat and instanced transport. Browser qualification:
  `git show 4fbbe8dd5:scripts/perf/evidence/yup-orientation-2026-09-07/browser-qualification.json`.

### Retained mesh bookkeeping and no-op copies (#3988)

Orientation reuses deterministic edge adjacency, triangle filters compact their existing index buffer, and welding/content hashing avoid duplicate map probes. Geometry policy, tolerances and traversal/output order remain unchanged. Own-layer native subset comparisons did not establish a meaningful full-load improvement; sampled leaf CPU and the cumulative result cannot establish a layer-specific gain. Preserve exact output and diagnostic oracles, including invalid/degenerate triangles and reused-buffer capacity. No isolated browser gain is established here; invalid Firefox cohorts and unrun follow-ups remain excluded. Owned-weld, sliver-incidence and alternate meshing experiments are not included.

### Dead ends (do NOT re-spike without a new mechanism)
- **More geometry workers** -> zero CSG speedup: memory-bandwidth bound, not CPU.
- **Shared entity-index for the VIEWER huge-file path** (#1445): CLOSED, branch
  deleted, REFUTED by an end-to-end 722MB re-measure. The retained-size spike looked
  great (152 vs 354 MB/worker, projected ~600 MB lower peak) but `peakWasm` went *up*
  ~680 MB (3930 vs 3250 MB): peak is set *during* the build, `from_columns`
  double-buffers a transient `Vec<(u32,u32,u32)>` + output `Vec<u8>`, and N workers
  building concurrently spike above the old single-FxHashMap footprint. Third
  isolated-bench-misled case after #1429 and Manifold. Do NOT re-attempt without a
  transient-free in-place build — and even then the index is not the dominant cost
  (the per-worker 1x source copy is). (The single-consumer export/native shared index
  above is a *different* thing and did ship.)
- **Threaded WASM CSG** (#1429): 4.19x CSG-only isolated, but whole-pipeline only
  2.33x @ 4 threads and it REGRESSED at 8 threads (atomics tax + SAB scaling). Second
  isolated-bench-misled case. `init_thread_pool` survives in the off-by-default
  `threads` bundle only; the live path is the JS worker pool.
- **Void-cut dedup** (#1286-P5 / #1571): ~4% eligible on real models (plan-rotated
  walls ineligible AND costliest); world-frame cut can't be byte-identical. PARKED.
- **Content-dedup** (#1130): hash re-decodes the subtree, 20-30% slower net. OFF.
  (It became a NET LOSS once rect_fast made CSG cheap — a "regime rot" example: a
  measured win can flip when the surrounding cost regime changes.)
- **Manifold WASM / BSP kernel**: deleted at M9; pure-Rust exact kernel is the only
  one. C++ accelerator was a dead end.
- **Rect-fast void path**: correct where it fires but barely fires (0 on Revit/Tekla);
  not the lever.
- **CSG exact-arith**: ~15ms/cut floor is the arithmetic cost; the only lever there
  is *doing fewer/cheaper cuts* (analytic bypass), not faster exact CSG.
- **`wasm-opt` for size**: a NET LOSS on the *shipped* (brotli-compressed) bundle —
  it grows the brotli-compressed transfer size even when it shrinks the raw `.wasm`.
  Track raw AND brotli, and gate on brotli (what the user downloads).
- **`bnum` fixed-width bigint** (bnum#74): OBSOLETE post-FixedInt; the -8.9% it once
  bought is now ~0%. Another regime-rot casualty.
- **Component parity BVH filtering** (#4054, PR #4060): conservative per-component BVH
  filtering of the exact parity candidate scan, query endpoint and predicates unchanged.
  A one-pair fresh-process Chrome screen over 27 fixtures established NO corpus cold-load
  gain: one candidate run timed out after 240 s waiting for renderer finalization while its
  baseline passed, both sides of the largest fixture timed out closing Chrome, and two
  completed pairs failed the raw geometry-channel gate. **Lesson:** a classification hotspot
  does not extrapolate to an end-to-end win, and no small-component threshold is justified by
  these observations. Rejected source, the only public copy (the spike commits are not on any
  remote): `git show 4fbbe8dd5:scripts/perf/evidence/component-parity-bvh-rejected-2026-09-07/measured-candidate.patch`,
  applied to public base `96ea5f08e` with `git apply --unidiff-zero`. The test-only extension
  `bdc38d30c` chain-applies after it and is likewise public only here:
  `git show 4fbbe8dd5:scripts/perf/evidence/component-parity-bvh-rejected-2026-09-07/later-tests.patch`.
- **CDT constraint-inventory vertex reuse** (#4055, PR #4061): reusing the constraint
  inventory during refinement. Native full processing call over 27 fixtures x 5 interleaved
  fresh-process pairs: **-1.17%** by ratio of model medians, **-1.27%** by median paired ratio.
  Two estimators, not one result. The corrected-orientation browser screen was **+0.63%
  SLOWER** in complete readiness on the historical 11-model subset, and 3 of 27 pairs were
  rejected on TWO different gates, which the evidence deliberately kept apart: the 511 MB and
  263 MB pairs failed the raw mesh-count, canonical-hash, AABB/volume and spatial-multiset
  gates, while the 1.259 GB pair passed every one of those and failed the browser-close
  watchdog on BOTH arms (nonzero exit plus teardown failure). The close hang is unexplained
  and is not evidence about the candidate's geometry. **Lesson:** exact instrumented producer
  output on one fixture does not waive downstream browser mismatches; do not re-spike this on
  a microbenchmark, a normalized mesh comparison or selected-fixture timing. Rejected source,
  the only public copy:
  `git show 4fbbe8dd5:scripts/perf/evidence/rejected-vertex-reuse-2026-09-07/measured-candidate.patch`,
  applied to public base `e40992485` with `git apply --unidiff-zero`. The test follow-up
  `c0ef3e802` chain-applies after it and is likewise public only here:
  `git show 4fbbe8dd5:scripts/perf/evidence/rejected-vertex-reuse-2026-09-07/test-followup.patch`.
- **Owned server mesh-batch transfer** (#4066, PR #4072): an owned sink in the canonical
  processing loop removed the server bridge's deep mesh-buffer copy, preserving the borrowed
  API, retained output, batching, progress, styling and cancellation. Exact output and
  hash-only cache replay passed; the prespecified actual-HTTP readiness continuation gate did
  not. The small and MEP models were slower in their single pairs, and the largest model's
  modest time improvement came with higher sampled RSS. **Lesson:** removing a real
  source-level copy is not by itself an end-to-end gain; unbounded downstream ownership and
  the rest of the pipeline remain the cost. Rejected source, the only public copy:
  `git show 4fbbe8dd5:scripts/perf/evidence/rejected-owned-batches-2026-09-07/measured-candidate.patch`,
  applied to public base `1b95c6652` with `git apply --unidiff-zero`.
- **Server PGO, both variants** (#4059, PRs #4068/#4069/#4070/#4071): the native `perf_probe`
  full-value profile DID qualify: **-9.81%** aggregate processing-call time over 27 models
  (-9.97% on the 22 held out), with exact ordered geometry fingerprints and counts in all 135
  pairs. But the largest model carried a **+5.27%** median-time penalty and aggregate
  whole-process physical footprint rose **1.39%**. Neither actual-server screen inherited it:
  the counter-only HTTP screen and the full-value HTTP screen both missed their predeclared
  continuation threshold, and both kept a CSG diagnostic mismatch on the 263 MB model that
  exact geometry bytes did not waive: Complete-path CSG failures 195 -> 196 on the
  counter-only screen and 194 -> 196 on the full-value one, mechanism tracked at #4067. The
  census varies WITHIN each arm too (native probe baseline 194, 195, 197, 198; candidate 194,
  195, 196, 197), which is why the mismatch is a limitation to explain rather than a
  difference to average away. **Lesson:** a probe win does not transfer to the shipping
  server, which differs in allocator, features, build-std configuration and target. Never
  reuse a profile between the two artifacts. The flags that decide the result, inline because a
  re-spike gets exactly these wrong:
  - control `RUSTFLAGS` is **empty** on both sides;
  - generation adds `-Cprofile-generate=<fresh raw dir>`, plus (Darwin, **counter-only
    continuous training only**) `-Clink-arg=-Wl,-sectalign,__DATA,__llvm_prf_cnts,0x4000` and
    the same for `__llvm_prf_data` / `__llvm_prf_bits`; full-value training adds neither those
    nor `%c` to `LLVM_PROFILE_FILE`;
  - use adds `-Cprofile-use=<merged.profdata> -Cllvm-args=-pgo-warn-missing-function`, and
    the full-value server build adds `-Cllvm-args=-no-pgo-warn-mismatch-comdat-weak=false` on
    top so weak/comdat mismatches are reported rather than hidden;
  - the server artifact is built `CARGO_UNSTABLE_BUILD_STD=std,panic_abort cargo build
    --release -p ifc-lite-server --target aarch64-apple-darwin`, while the probe is
    `cargo build --profile server-release -p ifc-lite-processing --example perf_probe`, which
    is why their profiles are not interchangeable.

  Driver and full recipe: `git show 4fbbe8dd5:scripts/perf/evidence/server-pgo-darwin-2026-09-07/README.md` and
  `git show 4fbbe8dd5:scripts/perf/evidence/server-pgo-darwin-2026-09-07/reproduce`. The three
  screens:
  `git show 4fbbe8dd5:scripts/perf/evidence/native-pgo-current-2026-09-07/README.md`,
  `git show 4fbbe8dd5:scripts/perf/evidence/server-pgo-counter-http-4059/README.md`,
  `git show 4fbbe8dd5:scripts/perf/evidence/server-pgo-full-value-http-4059/README.md`.
- **Canonical type-ordinal handoff across the worker index** (#4031): rejected, no PR opened.
  A fixed 11-model Chrome cohort ran all 110 predeclared fresh-process runs; 109 succeeded and
  one crashed before readiness (CDP errorCode 4), so the independent audit rejected the
  cohort. Across the ten models with five complete pairs, median paired full-readiness changes
  were small and mixed, spanning **-3.07%** (architecture-343) to **+2.46%** (CSG177), with
  CSG177 and Tekla slower in four of five pairs; CSG177's physical footprint was higher in
  EVERY pair. **Lesson:** metadata improved more than full readiness did, so the removed
  reconstruction work never controlled the end-to-end boundary. Evidence is private and the
  verdict lived only in the issue's closing comment until now; the harness fixes it paid for
  landed separately as PRs #4035 and #4037.

### Cold-start / CSG levers — mixed status (read each label)
- **Viewer drawing demand, property-set discovery and parser scheduling (RETAINED, measured):** a saved
  section-overlay preference does not imply an active drawing consumer. Match
  the renderer's section-tool demand, preserve explicit export generation, and
  refresh inputs when a consumer becomes active again. On large cold loads the
  previous hidden section cut blocked metadata delivery and renderer readiness.
  Sorted parser indexes also need no permutation; association-target discovery
  was dead work once all references were indexed. A conservative resident-byte
  ePSet filter skips only proven negatives, retaining the canonical decoder for
  escaped names and possible matches. Disabling only the DXF caller did not
  help: another required georeference consumer paid the same work later.
  Parser reference arrays can overlap the geometry workers' peak allocation.
  Giving geometry a bounded head start reduces that overlap: hand off the
  already-built shared index when a worker finishes, at stream completion, or
  at a source-size-scaled deadline. Always release it on iterator shutdown too.
  Waiting only for worker completion regressed an architecture model; the
  deadline bounds that tradeoff and avoids the parser's fallback scan timeout.
  Keep smaller sources immediate: deferring a structural fixture increased its
  renderer peak despite faster loading; immediate handoff removed that increase.
  Final fresh-process comparisons across MEP, architecture, sanitary, CSG,
  structural and bridge models improved every full-readiness median, with
  matching geometry digests and real GPU picks, properties and spatial paths.
  The large target reduced whole-browser RSS and renderer peak footprint;
  smaller-model total RSS remained variable, so this is not a universal memory
  reduction claim. Actual section-tool activation produced identical cut
  geometry on small and large models. Single-to-federated loading preserved
  selection, properties and spatial hierarchy; metadata-only input still settled.
  Active drawing requests share one queue: geometry, plane and visibility
  changes keep only the newest pending inputs, and superseded cuts cannot
  publish. Parser-worker-unavailable loads do not retain a deferred handoff.
  An interleaved ablation across MEP, CSG, structural, bridge and small models
  found no material full-load or RSS benefit from retaining WASM batch decoder
  memos, including completed BREP signatures. That extra WASM cache machinery
  was removed; the native shared signature cache remains independently useful.
  Clearing local reference variables and delaying only until the first mesh
  batch did not reliably reduce whole-load memory either.
  Rare Chrome ARM64 renderer SIGILLs occurred during the style pre-pass on
  both the performance candidate and the unoptimized corrected baseline.
  Preserve failed runs alongside successful timing samples; successful replays
  do not establish a fix or equal failure rates. Follow-up #3975 carries the
  crash dumps, reproduction conditions and bounded engine/application diagnosis.
  This change does not claim to fix that shared reliability defect.
  Geometry-only events and truncated worker-memory summaries cannot settle it.
Entries below are tagged individually: CANDIDATE (measured once, not validated end-to-end),
SHIPPED (landed with a PR), or RE-REFUTED / NOT SHIPPABLE. Do not read the section as
"all unshipped".
- **GLB export trailing georeferencing** (PARKED after #5357 spike): export
  still does not consume the returned georeferencing metadata, but the old
  whole-file scan explanation is obsolete: extraction now reuses scan candidates.
  Property-set candidate decoding remains. A suppression prototype preserved the
  tested complete GLBs, including site/RTC behavior; its shared-host timings do
  not establish an end-to-end win. A production opt-out must be export-scoped
  and preserve public options compatibility. See the
  [source, observations and qualification limits](evidence/export-delivery-5357/README.md).
- **Bounded GLB geometry replay** (NOT SHIPPED after #5557 screen): recording
  the planning pass's meshes on native scratch and replaying them through the
  existing writer avoided a second meshing pass, with complete artifact identity
  in the controlled native screen. The prototype has no first-party native GLB
  consumer: CLI, MCP and viewer source-byte export use WASM, and the viewer's
  loaded-mesh export uses a different path. A replay cache large enough for the
  heavy fixture would undermine the bounded WASM memory contract. Do not add a
  native-only public API without an actual consumer; a future attempt needs a
  consumer and a portable scratch/error policy, or a separately qualified
  memory-bounded WASM design. No browser or CLI gain is established. See the
  [#5557 screen and archived patches](../../docs/architecture/evidence/bounded-glb-replay-5557/README.md)
  and the earlier #5357 archive above.
- **Brotli quality 11 on the served bundle** (PARKED after #5357 observation):
  the actual deployed WASM response already negotiates Brotli and compiles in
  Chrome. Recompressing those same decoded bytes locally leaves potential
  transfer savings, but there was no authenticated preview to verify altered
  delivery. Actual response headers, transfer/body sizes and byte-identity checks
  are archived above. No deployed improvement or whole-viewer cold-load win is
  claimed; local compressed size alone still cannot qualify this lever.
- **Parser worker's unused WASM compile** (SHIPPED, PR #1851): NOT the "compile outside
  the shared memo" this was first framed as. Verified: on the streaming cold-load path
  (`waitForEntityIndex`, every file >=2 MB) the parser worker eager-compiled the ~3.9 MB
  scanner and then NEVER USED IT — the geometry pre-pass hands over the entity index and
  `entity-scanner.ts` short-circuits before the wasm scan. So the compile was pure waste
  stealing a core from the concurrent pre-pass. Fix = defer the compile (eager only on
  the no-handoff path; lazy on the timeout fallback). Win = CPU-contention relief on the
  parse<->pre-pass overlap; shows on LOW-CORE devices, so read magnitude off the CI
  viewer benchmark / PostHog, not a fast dev machine. Lesson: the "shared compile memo"
  fix was a mis-frame — verify the code path before building the fix the research names.
- **Threaded WASM CSG — in-instance rayon** (RE-REFUTED end-to-end, measured
  2026-07-23; keep in the dead-end column): a fresh browser A/B on ISSUE_129 (the most
  CSG-heavy public model, 71% CSG) settles the old CONTESTED status against threading.
  The CSG *kernel* really does parallelize in WASM (corpus replay 4152 -> 1724 ms,
  **2.41x**), but the **full pipeline REGRESSED**: plain single-thread 6450 ms vs
  threaded-8T 7383 ms = **0.87x** (byte-identical, fp=1402). The atomics tax on the
  serial parse/decode majority (2298 -> 5659 ms, ~2.5x slower) exceeds the CSG savings.
  ISSUE_129 is the *best* case, so lighter models are worse. This vindicates #1429 and
  supersedes the `docs/architecture/csg-threading-design.md` rung-2 "1.6-1.9x
  end-to-end" numbers, which have regime-rotted (see below). Do NOT wire `pkg-threaded`
  without first defeating the whole-pipeline atomics tax (not just the CSG step).
  Data: `csg-thread-bench` build.sh was itself broken (missing shared-memory link args)
  and never booted the threaded bundle until fixed in this PR.
- **Regime rot: CSG is no longer the universal bottleneck.** Native capture 2026-07-23
  (`csg_scaling_bench`): the *expensive-CSG* corpus has collapsed 10-160x vs the
  threading-doc era as the fast paths (rect_fast, analytic bypass, faceted-brep dedup)
  matured. advanced_model CSG = **4%** of load (13/316 ms; doc: 103 jobs/26 s), dental
  32%, ISSUE_068 33%, ISSUE_129 71%. The dominant cost on the majority of models is now
  the **single-threaded parse/prepass/decode/extrude path** (advanced_model 96% non-CSG),
  which gates time-to-first-geometry and hits every model — that, not CSG threading, is
  where the next real speedup lives.
- **Wide-arithmetic exact-CSG bundle** (~1.7x on a real void cut — NOT SHIPPABLE TODAY):
  built by `BUILD_WIDE=1 scripts/build-wasm.sh`, but **V8 does not run it**. Measured
  2026-07-31 on V8 (Node 22 / V8 12.4 and Node 26.5.1 / V8 14.6): a module using
  every wide op the bundle emits fails `WebAssembly.validate`, compiling it throws
  `invalid numeric opcode: 0xfc13`, and `node --v8-options` lists **no**
  wide-arithmetic flag under any name. An earlier
  entry here claimed V8 had it behind a default-off
  `--experimental-wasm-wide-arithmetic`; that flag has never existed, so do NOT wait
  for it to be "staged" — there is nothing to stage. Firefox (SpiderMonkey) and Safari
  (JavaScriptCore) were not measured; treat them as unverified, not as rejecting.
  Track-and-adopt only; the runtime feature-probe
  (`packages/geometry/src/wasm-features.ts`, not yet created) would auto-upgrade per engine
  as each ships. The CI tripwire (`.github/workflows/wide-arithmetic.yml`) probes the
  engine every week and turns red when this changes. See
  `docs/architecture/wasm-wide-arithmetic.md` (delivery status verified 2026-07-31).

- **Content-dedup signature walk on large single BREPs** (~2.00x traversal, SHIPPED #1909):
  `item_dedup_key` walked every face/bound/loop/point of an `IfcFacetedBrep` to build a
  dedup key — a second full traversal mirroring the mesher's own. On a model that is one
  large BREP with no repeats, that key can never pay off. Gated on
  `FACETED_BREP_DEDUP_FACE_LIMIT` (20,000 faces), measured with a **deterministic counter**
  (`EntityDecoder::point_cache_stats()`), not wall-clock: 5,880,000 accesses with dedup on
  vs 2,940,000 with it off on a synthetic 980k-face BREP — exactly 2.00x — and 1.00x after.
  Post-mesh `get_or_cache_by_hash` and `direct_rep_identity` still run, so genuinely repeated
  large geometry still dedups and still instances (asserted by test).
  **Lesson, and the reason this entry exists:** an end-to-end suite verdict **cannot be
  produced for this lever on the current corpus.** The largest BREP across all 163 fixtures
  is 8,848 faces, so nothing in the suite crosses a 20,000-face gate; a base-vs-branch A/B
  swung -10%/+9%/-7% with the sign tracking run order, i.e. pure noise. Do not spend another
  afternoon on `probe.sh --suite` for a threshold this corpus cannot reach — either add a
  fixture above the gate, or measure with a deterministic counter as above. The 20,000 figure
  is a judgement call (an order of magnitude clear of realistic repeated parts, which run to
  low hundreds of faces), not a measured optimum.

### Retained canonical lexical and schema work (#4001)

Reuse checked ID-prefix accumulation and the scanner's existing ASCII proof; obtain native geometry flags from one immutable classification lookup. Generated type parsing checks canonical names before normalization, and schema detection retains the original match priority. Own-layer native subset comparisons showed a modest full-load improvement, not a corpus-wide or browser result. Keep the cumulative verdict separate and exclude invalid Firefox cohorts and unrun follow-ups. Scalar tokenizer dispatch, scanner dictionaries and ordinal transport are separate experiments, not part of this change.

### Measured feature costs (not levers — recorded so nobody re-measures)
- **Local-frame void-cut origin preservation** (#3446, measured 2026-08-31,
  base = `2edd144329`, arm64 native). This correctness fix keeps a rotated
  local-frame cut's centre and nested origin out of absolute-world `f32`.
  `probe.sh --iters 5 --json` found no performance signal: AC20-FZK-Haus best
  total/geometry was 10/5 -> 9/5 ms (base totals 14,10,10,10,10; branch
  11,10,9,9,9); ISSUE_129 was 623/604 -> 627/608 ms, inside the base's
  623..633 ms spread. Mesh/vertex/triangle counts match on both fixtures
  (AC20 285/35940/19456; ISSUE_129 1402/218346/132673). The branch intentionally
  changes the far-field void corpus, so the pinned native/wasm manifests and
  arm64 determinism harness are the stronger output evidence. Holter was not
  measured: its fixture endpoint repeatedly served a SHA-256 mismatch.

- **Legacy-site georeference negative-zero recovery (#3546 residual): no
  measurable geometry-pipeline regression.** The localized raw-record scan runs
  only while extracting `IfcSite.RefLatitude`/`RefLongitude`; it deliberately
  leaves the shared integer tokenizer untouched. Interleaved five-round native
  `perf_probe` A/B (`3d9ab0e30` -> `e81f41d66`, Apple Silicon) was below the
  harness's noise threshold: FZK-Haus total 10 -> 10 ms (mesh/vertex/triangle
  counts 285/35,940/19,456 on both); CSG-heavy ISSUE_129 total 608 -> 609 ms
  (+0.16%, base spread 2.96%) and geometry 591 -> 592 ms (+0.17%, base spread
  3.38%), with identical 1,402/218,346/132,673 output counts. **Lesson:** this
  compatibility recovery is metadata-only and too rare/small for this coarse
  end-to-end probe to distinguish from run noise; retain the behavioral fixtures
  rather than treating the apparent one-millisecond movement as a regression.
- **Geometry fingerprint pass: world AABB + volume + closure verdict**
  (#1891/#1988, PR #1993, measured 2026-08-02, base = merge-base `8f139a8e`).
  The pass gained a per-triangle tetra determinant and a six-way bounds update.
  Verdict: **hashing OFF is unaffected, hashing ON costs a fraction of a
  percent.** Output byte-identical throughout — mesh/vertex/triangle counts
  unchanged on every fixture, and an FNV-1a over every `geometryHashValues`
  entry is equal base-vs-branch on all three (so the new arrays did not perturb
  the fingerprint they ride with).
  - Native `probe.sh --iters 5`, interleaved rounds, hashing off (the only mode
    the native pipeline has — see the harness gap below): AC20-FZK-Haus
    10 -> 10 ms total; ISSUE_129 median-of-6-rounds +1.4% inside a ±10%
    round-to-round band (per-round minima 683..984 ms on base alone);
    Holter/ISSUE_053 977 -> 967 ms (-1.0%). No signal either way.
  - WASM boundary (`buildPrePassOnce` + `processGeometryBatch` in node, 3
    interleaved rounds), min ms base -> branch: AC20 off 49.0 -> 49.1 (+0.2%),
    on 50.1 -> 50.5 (+0.8%); ISSUE_129 off 1983.9 -> 1987.9 (+0.2%), on
    1989.0 -> 1999.4 (+0.5%); Holter off 3555.7 -> 3600.1 (+1.2%), on
    3790.6 -> 3849.8 (+1.6%).
  - Turning the SWITCH on is the real cost, and it is the same on both sides:
    off -> on is +2.9%/+0.6%/+6.9% on branch versus +2.2%/+0.3%/+6.6% on base,
    i.e. this PR adds ~0.3-0.7 pp to a surcharge that only the diff feature pays.
  - Honest outlier: hashing-off on Holter reads +1.2% at the wasm boundary while
    the native probe on the same fixture reads -1.0%. Nothing in the
    hashing-off path changed — the hasher is `None`, so every new accumulator is
    dead code — and the delta sits inside the base's own 3528..3584 ms spread,
    so read it as the 3.7 KB binary-size / code-layout shift, not added work.
  - **Harness gap, worth fixing before the next hashing change:** `perf_probe`
    CANNOT reach the hashing path. `process_geometry` -> `processor/jobs.rs`
    hardcodes `MeshProductionOptions::default()`, so `geometry_hash` is always
    `None` natively and the fingerprint pass only exists behind
    `IfcAPI::setComputeGeometryHashes`. The hashing-on numbers above therefore
    come from driving the real wasm entry point, not from `probe.sh`.

- **Second harness gap, same shape: `probe.sh` cannot reach the SYMBOLIC path
  either** (found on #2358, 2026-08-11). `perf_probe` drives `process_geometry`,
  which never populates `symbolic_data`; annotation/placement work hangs off a
  separate entry point, `extract_symbolic_data`, called by the wasm binding and
  the server. So a symbolic-only change produces a **flat, identical probe table
  on both sides** — which reads exactly like "no regression" but is a control,
  not a measurement. If the diff is under `rust/processing/src/symbolic/`, say so
  and drive `extract_symbolic_data` directly, rather than pasting a zero.
  - **And pick the fixture by whether it exercises the branch, not by the default.**
    #2358 only does extra work when a symbolic rep's `ContextOfItems` is a full
    `IfcGeometricRepresentationContext`. The default fixture AC20-FZK-Haus has
    **zero** such reps (all 34 are SubContext) and C20-Institute zero of 316;
    `dental_clinic.ifc` has **1080**. Scan the corpus for the shape your diff
    touches before measuring, or the "canonical" fixture will confirm nothing.
  - Related trap when reading byte-identity on this path: **every WCS in the
    corpus is the identity**, which is precisely why the #2358 bug survived —
    resolving it correctly and never resolving it agree on every shipped fixture.
    Identical output there is evidence about the corpus, not about the change.

### Retained prepass source fingerprint sharing (#3985)

The existing prepass can publish the exact full-byte source key through a fresh per-load shared cell, including malformed tails. The parser uses it only when already ready; prior entry points and unavailable-cell fallback remain compatible without another source copy or worker. Retained cumulative qualification is not an isolated percentage claim. Record actual parser/prepass key origin when diagnosing overlap; an unavailable key can still pay the original parser hash.

### Reading the FIELD telemetry (PostHog) — verdicts and traps

- **A per-model PostHog regression alert is device-mix noise until you control for
  device — and at this traffic level it CANNOT be made to control for device**
  (2026-08-08, alert "Per-model load regression — any model >2x baseline").
  It fired at `x_change = 2.29` on one fingerprint (76.7 MB / 6668 meshes,
  14406 -> 32994 ms median). It is **NOT a regression.**
  - The decisive estimator is the **within-person same-model paired ratio**:
    for every (person, model) cell with loads in both windows, `median(recent) /
    median(baseline)`. Fleet-wide that is **0.927** (IQR 0.852-1.127) over 24
    cells / 16 persons / 97 loads — i.e. slightly *faster*. This holds the device
    constant by construction, which is the only property that matters here.
  - The fingerprint that fired has **zero** paired persons: 11 loads in 90 days by
    10 different people, no person in both windows. Its paired ratio is not
    small, it is **undefined** — there was never a regression estimate, only a
    comparison of one set of laptops against another.
  - **A per-model alert is not salvageable at current volume.** Across the whole
    17-day window, **no** model fingerprint has more than **one** paired person
    (24 fingerprints have exactly 1, 1825 have 0). Any per-model gate strong
    enough to be sound can never fire. Alert **fleet-wide** on the pooled paired
    ratio and keep per-model as a drill-down insight.
  - **Two tempting controls that are circular — do not lean on them.** (1)
    Normalising each load by that person's own median ms/MB *over the full
    window* looks great (it collapses 2.29x to 1.00x) but the divisor is computed
    from inside the suspect window, so a real uniform 2x regression normalises to
    ~1.4x and a person whose only loads are recent cancels out by construction.
    If you normalise, build the divisor from the **baseline window only**.
    (2) "The one person who loaded it on both recent builds got faster" compares
    two *recent* builds to each other and never bridges the windows.
  **Lesson:** the alert's anti-false-positive gates (>=5 loads, >=3 persons per
  window, recent p25 >= baseline median) are all satisfiable by five loads from
  five *different* laptops. Person count is not person *overlap*. This is the
  second retracted field perf claim on this project (see the #2183 "compression
  is worse" retraction) — both died to contaminated measurement, not to bad code.
- **A `total_triangles` change for one file can split WITHIN a single build.**
  On the fingerprint above, build `1aa498e26339` emitted **both** 4423296 (two
  persons) and 4432196 (a third) — same file, same `mesh_count` (6668), same
  `file_size_mb` to 2dp. Because the split is inside one build, every
  commit-range / "which merge changed the mesher" argument is moot, and so is
  fingerprint collision (it would need two files matching to +-5 KB and +-0
  meshes while differing 0.2% in triangles). An identical mesh roster with more
  triangles distributed *within* it means **environment-conditional
  triangulation on a deterministic code path** — most plausibly a CSG void cut
  that failed and fell back under memory pressure on one run. Note the CI
  determinism manifests would **not** catch this (pinned fixtures, controlled
  memory), so if CSG fallback is the mechanism it is known-by-design variance,
  not a latent determinism defect. `total_csg_failures` now rides
  `ifc_model_loaded` so this is answerable from telemetry. Do **not** spend a
  probe on `?geomWorkers=N`: `useIfcLoader.ts` documents that worker count cannot
  affect output (disjoint deterministic element slices), so that probe is
  predicted clean by the codebase itself.
- **`total_elapsed_ms` is not pure compute — it contained an unbounded hidden-tab
  stall** (#2385, fixed). `useIfcLoader` awaited a bare `requestAnimationFrame`
  at stream-complete; rAF is never serviced while the document is hidden, so a
  tabbed-away load parked there indefinitely. Field evidence: 30 days of loads
  contain a 25-hour and a 3.4-hour `total_elapsed_ms`, and 20 loads over 60 s of
  post-stream time on models under 5000 meshes — durations no amount of finalize
  work can produce. 5.5% of all loads (420 / 7605) spent over 10 s after
  `stream_complete_ms`. **When mining this event, treat `total_elapsed_ms` minus
  `stream_complete_ms` above ~30 s as a visibility artifact, not compute, on any
  data captured before this fix.** That duration cut is a stopgap and has a real
  cost — it also hides a genuine slow-finalize regression. `ifc_model_loaded` now
  carries **`was_hidden`**; once it has 17 days of history, filter on
  `was_hidden != true` instead, which excludes the artifact without blinding the
  metric.
- **BVH construction no longer sorts every subtree synchronously** (#5252).
  The old `BVH.build` re-sorted each node's index slice and blocked the main
  thread during phase 2. A bounded median selection now builds the same exact
  leaf set with expected O(N log N) work; a heap-sort fallback bounds adversarial
  partitions. The async builder also slices phase 2, yielding through a timer
  while visible so Chromium can paint, and through the existing scheduler while
  hidden so background timer throttling does not stall the load. Keep exact
  query equivalence against brute-force AABB tests as the correctness oracle:
  tree shape and node order may change. A phase-2 microbench cannot establish a
  load win; use interleaved cold browser loads of the same IFC and compare
  spatial readiness, total load, mesh counts and visible-frame progress. The
  initial Holter browser cohort confirmed frame progress and no 14-second load,
  but concurrent host jobs made its small timing delta inconclusive.

### Source and buffer ownership during WASM prepass (#3989)

Source-session reuse, binding-owned index adoption and direct transfer of already-owned mesh getter arrays preserve byte-taking compatibility and source-replacement resets. The standalone own-layer native subset was slower in full-load timing, while Holter's measured peak memory fell; the cause remains unestablished and favorable memory does not waive the timing concern. The intended integrated merge parent differs from that standalone comparison, and its proposed comparison remains unrun; results with different parents must not be pooled. Combined native/browser results do not isolate a gain for this layer, and invalid Firefox cohorts provide no throughput evidence. Real WASM contracts verify returned buffers survive handle free, memory growth and transfer, including textures. Establish ownership at the binding: a JavaScript view does not remove the WASM input copy, and borrowed WASM-memory views must not be transferred as owned output.

### Standing constraints
- Geometry is **client-side only** (no server meshing).
- One mesh home: `produce_element_meshes` - a fix in one pipeline diverges the other.
- Parity gates: `mesh_determinism` manifests (x86_64 + arm64 + wasm32),
  `styling_parity`, `exact_predicate_determinism`. A real output change re-pins them.

### Manual browser readiness boundary (#3978)

The manual server matches deployed COOP/COEP (`same-origin` / `credentialless`)
and records `crossOriginIsolated` plus SharedArrayBuffer availability, refusing
samples without them. `--port` selects both server and shared benchmark-page
origin; the default remains 3000 for CI compatibility.

`metadataRenderReadyMs` is the first successful observation from a 100ms polling
loop after file selection: metadata, geometry, renderer-completion logs and a
canvas check. WebGPU falls back to nonzero canvas dimensions, so this is not a
pixel-readback or exact paint timestamp. Screenshots are separate post-boundary
artifacts. Polling and automation latency are included; differences on that
scale cannot establish small-model causal gains. The manual path skips the
legacy fixed one-second pre-observation sleep; CI keeps its original default.

Manual runs default to five interleaved pairs. Fewer pairs remain available for
functional smoke checks, but the reporter withholds noise estimates and performance
verdicts. Any failed sample makes the report exit nonzero, including when other
rounds completed. Renderer readiness requires the successful streaming-finalization
log; the app summary and an allocated canvas do not establish GPU readiness.

For local real-GPU Chrome qualification, pass `--headed --browser-executable
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"` to either manual
entrypoint. The record includes the selected executable, browser version, headed
mode and GPU arguments. The default remains bundled Chromium headless, which may
not provide WebGPU on a particular host; renderer failure invalidates that sample.
Never compare different launch modes or browser artifacts as a code A/B.

Headless bundled Chromium has no GPU adapter, so a renderer-readiness smoke needs headed
installed Chrome with cross-origin isolation and SharedArrayBuffer; the first three #3978
attempts are retained as invalid for exactly that reason (PR #4035). Capture and
fixture/runtime hashes: `git show 4fbbe8dd5:scripts/perf/evidence/harness-readiness-3978-2026-09-06/capture.json`.

### Retained column-native metadata preparation (#3985)

Keep pre-scanned numeric entity columns through categorization and reuse equivalent borrowed columns during cache index serialization. The shared validated row walk retains stable duplicates, deferred atoms and complete reference access; generic iterable indexes remain supported. This removes transient reference-object reconstruction without adding another loader or dropping metadata. Retained cumulative qualification does not establish an isolated per-layer percentage.

### Retained cold-load work: search index ownership (#3993)

The viewer shell owns search indexing for the lifetime of each loaded model.
Search interfaces consume the same records, so opening or closing search does
not create another owner or abandon its index. Cleanup releases in-flight
claims, and stale promises cannot replace a newer build. Lifecycle tests cover
StrictMode, unmount and partial/final metadata publications. This removes
redundant work and preserves search availability; no separate cold-load speedup
is attributed to this layer. Final frozen-artifact functional runs exercise actual search, model-ID resolution,
properties and GPU picking with one and multiple models, including cache-hit
reopening. Coverage limits ride the retained cold-load stack bullet under Shipped wins.

### Retained parser publication and receiver ownership (#3985)

Pack immutable type-index publication once and reuse partial columns on complete, retaining legacy transport and shared source access. Terminate the completed parser worker before receiver hydration and use the compact maximum ID during ingestion. Retained as cumulative cold-load work, with no isolated percentage attributed. Qualification must include full property/reference access, federation and memory through cache completion; worker completion alone is not readiness.

### Retained cold-load work: exact LOD keys (#3991)

Bounded LOD cell neighborhoods use exact integer keys containing all three cell
coordinates and the full entity ID. Inputs outside the proved range keep the
existing string representation. The independent tuple oracle checks identical
representatives and triangle order, including range boundaries, subviews,
nonfinite coordinates and full-width entity IDs. This removes per-vertex key
allocation; no isolated end-to-end speedup is attributed to this layer. The
retained cold-load stack must carry its cumulative browser qualification,
including picking and peak-memory observations, before landing.

### Retained cold-load work: bounded cache compression (#4003)

Geometry cache compression can run in one lazy module worker, using the same
codec and bounded chunk window as the workerless writer. The viewer opts in;
SDK callers retain the workerless default. Only fresh serialized chunks transfer,
and worker failures reject the cache write with deterministic disposal. This
moves compression off the interaction thread without removing its CPU or memory
cost. Cumulative qualification must include cache completion, full-lifetime
memory and actual cache reopening; raw IFC timing must not be replaced by a
prepared reload. No isolated throughput gain is attributed to this layer.

Explicit corpus entries are mandatory: missing files, duplicate fixture labels
and colliding filename keys fail before launching a browser. Default outputs use
a fresh per-run directory; existing JSONL/report/screenshot evidence is refused
rather than overwritten. Ref comparisons require a source WASM build and verify
the bundled viewer engine has the same hash after Turbo. They do not fetch a
published engine as a substitute. Without wasm-pack, supply independently frozen
distributions directly to the TypeScript entrypoint and retain their provenance.
`--skip-branch-build` labels its input as supplied distribution, not a verified
current-commit build. The wrapper retains the temporary base through child exit
and then removes it while preserving the child failure status.


### Appearance preview ownership and batch restoration (#4243)

A production-viewer API experiment on normally loaded FZK geometry found that
isolating shared batches for reversible appearance previews left persistent
partitions after cancellation. Exact geometry/bounds and GPU rectangle-picking
results survived, but repeated broad edits would retain extra draw batches.
Cohort-scoped restoration now stages a replacement only for descendants of the
same original batch once all related drafts close. Committed textured owners
remain separate; later Undo can rejoin their flat parts. The actual viewer
returned to the original batch count and primary geometry GPU residency.

This experiment measures synchronous Scene/Renderer preview phases, not IFC
planning, image decoding, end-to-end Apply latency, or GPU completion. The fixture
bounds the result to its eligible non-instanced owners; it does not qualify a
large-model whole-scope workflow. Resource snapshots exclude pick/highlight
caches and do not capture transient staging peaks. Restoration respects original
allocation limits and keeps valid split batches with a reported warning if
replacement allocation fails. The lesson is to check the post-cancel draw
structure as well as geometry and picking: a correct image alone hid persistent
batch fragmentation.

### Appearance Apply composition and unchanged dependency rows (#4243)

A real Convento whole-model Apply profile located synchronous dependency row
serialization and nested atomic snapshots in the click handler. Keep unchanged
non-binding source rows as bounded byte scans and compose appearance edits
inside the command's existing detached transaction; standalone helpers remain
atomic. Three interleaved fresh-browser A/B pairs show a combined reduction in
Apply delay, with identical geometry/UV bytes for all authored parts and intact
Undo/Redo and non-target-model isolation. The remaining frame stall still fails
the intended interaction smoothness bar. This is a development-viewer action
measurement, not cold-load throughput, GPU completion, or an isolated attribution
to either change. Raw samples and artifact hashes are retained in
`docs/architecture/evidence/appearance/appearance-apply-paired-summary.json` and
`appearance-apply-paired-manifest.json`. Preserve transaction ownership and
rollback checks while addressing the remaining work; do not remove them to
make an incomplete commit appear faster.

### Opt-in appearance planning (#4243)

Appearance planning invokes canonical mesh production for the source and planned
styles so preview topology agrees with reopening the exported IFC. It adds no
call to the ordinary load pipeline. Interleaved base/branch native house probes
found unchanged ordered mesh fingerprints and no observed ordinary-load timing
regression. This is a regression verdict, not a browser speedup claim. Keep
projection work in a cancellable worker and bound aggregate output as well as
input: a shared coordinate list can otherwise multiply into many UV arrays.

The planner must also resolve load-time RTC and material-layer context once per
request. Comparing two equally misconfigured routers can falsely certify empty
georeferenced triangles or an unsliced layer-bearing product; topology equality
alone is not proof of agreement with reopening. This context work stays on the
opt-in planner path and does not change ordinary load callers.

Embedded-header preflight reads PNG dimensions directly and walks bounded JPEG
markers through the STEP hex bytes. It neither copies the complete compressed
image nor allocates pixels before the plan budget is checked; ordinary raster
decoding remains unchanged.

### Effective appearance scope catalog (#4243)

The optional Rust catalog shares the planner's bounded effective-source decoder
and returns canonical product classes and type identities; it does not add a
call to ordinary model loading. Exact source-built base and branch WASM
distributions were compared through the actual browser worker pool in fresh,
interleaved processes. Every geometry fingerprint matched and no material
ordinary-load regression was observed within sample variation. This is a
regression check, not a speedup claim or a measurement of catalog latency.
Retain the bounded decode and shared cancellation lifecycle instead of
reimplementing IFC type relationships in the UI. Reproduction provenance and
samples are in `appearance-catalog-load-evidence.json`; the observation ends at
worker-model readiness, not renderer readiness.

### Prepared-overlay comparison ownership (#4243)

Compare a private borrowed overlay descriptor synchronously against the detached
checkpoint. Cloning the live overlay solely to compare it adds allocation while
providing no additional isolation; original/draft/prepared/publication snapshots
remain deep copies. Cyclic escaped values, skip-history edits and rollback
rejection remain covered. A fresh real Convento Apply profile with this change
and the earlier command/dependency changes still locates substantial synchronous
work in dependency scanning and authored-data/history construction plus retained
snapshots. This single sampled run does not establish an isolated improvement
for comparison-only clone removal. Keep ownership guards while investigating
preparation outside the Apply interaction. The profile, timing, summary and
exact source/runtime hashes are in
`docs/architecture/evidence/appearance/appearance-apply-after-comparison-*`.

### Appearance dependency validation: immutable source byte scan (#4243)

The Apply CPU profile identified effective dependency capture and repeated overlay
copies as the dominant main-thread work. Unchanged source rows already use
immutable markers in history checkpoints; decoding, rewriting and re-encoding
large coordinate rows only to extract references therefore adds no validation
information. Read those non-binding rows with the canonical source-byte scanner.
Keep edited, authored, retyped and inverse-binding rows on the effective STEP
writer path, with unchanged byte/reference budgets and compressed-source support.

Three interleaved fresh-browser Convento pairs showed a consistent end-to-end
Apply improvement when combined with removing nested appearance transactions.
This is a combined result, not an isolated speedup for the scanner. Geometry,
UVs, owner identity, Undo/Redo and the untouched federated model were checked;
the remaining main-thread stall still fails the intended smoothness requirement.
Do not treat fewer copies or a faster helper microbenchmark as acceptance: retain
the paired interaction measurement and continue profiling transaction preparation.

### Finite page appearance composition (#4260)

The opt-in page planner bakes topology-preserving PNG charts and retains source
texture density outside the page. It adds a PNG encoder to WASM; ordinary loading
does not invoke the new operation. Source-verified baseline and final runtimes
were compared in fresh interleaved browser workers under identical JS/assets.
All geometry, color, UV and provenance fingerprints matched. A small ordinary
worker-readiness increase was observed with overlapping samples; this is neither
a speedup nor a zero-cost claim. Retain the explicit atlas budgets and source
fidelity floor rather than silently downsampling photos to page resolution.
Exact runtime provenance, samples and deltas are in `pdf-page-load-evidence.json`;
page compositing latency and renderer readiness were not measured by this check.

### Cooperative appearance command preparation (#4336)

The appearance command now consumes owned cooperative entity operations and keeps
its final source, dependency, resource and history checks synchronous. A fresh
real Convento browser interaction confirms that preparation yields, but the
final synchronous phase still produces a visible long task and rendering gaps
remain during preparation. This is an observational integration sample, not an
isolated speedup or smoothness-complete verdict. Do not infer responsiveness from
an async return type or successful cancellation tests. Retain the exact fences
while addressing remaining synchronous dependency work separately. Raw timing,
source/runtime identity and functional Undo/Redo evidence are recorded under
`docs/architecture/evidence/appearance/appearance-cooperative-apply-*`.

### Calibrated image annotation creation (#4308)

The opt-in native annotation planner reuses canonical placement, schema validation and per-element geometry production. A source-matched ordinary worker-load A/B observed a small increase with overlapping samples and identical geometry/provenance; no speedup or zero-cost claim is made. Final JavaScript/assets were identical while the verified IFC WASM was swapped, so this checks runtime size/initialization effects without invoking annotation creation. See [the exact runtime hashes and paired samples](annotation-plane-load-evidence.json). Annotation creation and the downstream Save Into Model UI are outside this load measurement.

### Captured mesh authoring (#4380)

The opt-in captured-surface planner shares annotation authoring's canonical
product path; it does not modify ordinary geometry loading. Interleaved native
ordinary-load probes retained all mesh/vertex/triangle counts, but quantized and
noisy samples were inconclusive. Exclusive machine idleness was not established,
so these are smoke evidence only, not a speedup, regression or browser worker-pool
latency claim. The lesson is to compare triangle-corner geometry and UVs across
capture authoring and normal import: valid canonical welding may change vertex
layout while preserving the surface and seams. [Raw source-matched samples and
limitations](../../docs/architecture/evidence/captured-mesh/native-load.json)
record the experiment; capture-creation and integrated UI timing remain separate.

### Appearance preparation input scheduling (#4336)

Fresh background tasks allow trusted viewport and Discard input to run during broad
Apply preparation. In the paired real Convento viewer workflow, scheduler.yield
continuations painted frames but delayed trusted input until completion. This is
a different mechanism from timer-clamping or microbenchmark speedups: it trades
slightly longer elapsed preparation for earlier user interaction. The exact final
transaction fence is unchanged and still blocks. Identical runtime and canonical
owner/mesh output were verified across paired runs; cancellation published no IFC
or history changes. Raw evidence, memory caveats and methodology live in
`docs/architecture/evidence/appearance/apply-responsiveness/README.md`.

### Opt-in evaluated occurrence appearance (#4404)

Occurrence-local normalization runs only during an explicit appearance plan;
ordinary loading keeps its existing pipeline. Interleaved AC20 base/branch native
load probes found no resolvable regression at the probe's integer-millisecond
phase precision, with identical ordered mesh fingerprints and geometry counts.
This is native load evidence, not a worker-pool speedup or conversion-latency
claim. Preserve the opt-in boundary and measure broad authoring separately when
its host UI lands. [Raw samples and measurement limits](../../docs/architecture/evidence/evaluated-occurrences/native-load.json)
record the comparison.

The F6 composite-allocation follow-up keeps compaction inside authoring only.
Repeated base/branch AC20 load probes retained identical phase timings at the
probe's measurement precision and identical ordered mesh fingerprints. This
supports no resolvable native-load regression, not an authoring or worker-pool
speedup. Preserve literal-versus-reference schema slots when compacting plans;
never trade semantic fidelity for convenient generic string rewriting.
[Follow-up samples and limits](../../docs/architecture/evidence/evaluated-occurrences/allocation-load.json).

### Evaluated face masks and tessellatable-body policy (#4404)

Face masks and the widened evaluated policy live only inside an explicit
appearance plan; normal loading does not touch them. The interleaved,
order-balanced native AC20 base/branch probe (nine rounds per side, prebuilt
profiling binaries, `scripts/perf/ab-order.mjs` seed 4404) found phase
medians equal or within two milliseconds, every phase inside the reporter's
noise band, and the reporter refused a verdict because the base's own spread
exceeded its 15% threshold on a machine shared with other builds. This is
"no resolvable change", not a speedup or a regression claim, and no browser
worker-pool measurement was made. A separate `--fingerprint` run of both
binaries reports identical mesh, vertex and triangle counts and identical
ordered geometry fingerprints. Tool lesson: at the time of this probe
`scripts/perf/ab-order.mjs`'s CLI guard compared `import.meta.url` with a bare
`file://` prefix and printed nothing on Windows, so `ab.sh` there produced
zero rounds and a vacuous "within noise" verdict; the probe drove `roundOrder`
directly and checked the run count. #4541 fixed the guard with
`pathToFileURL`; always check the round count `ab.sh` reports.
[Raw rounds](../../docs/architecture/evidence/evaluated-face-masks/native-load.json) and [fingerprints](../../docs/architecture/evidence/evaluated-face-masks/native-fingerprints.json).

The #4550 native/wasm fingerprint-parity follow-up makes the existing
per-element local frame explicit only inside opt-in appearance planning. Fresh
interleaved base/branch and branch/base AC20 normal-load controls resolved no
change at the probe's phase precision, and every run retained identical mesh,
vertex and triangle counts plus ordered geometry fingerprint. The useful lesson
is to select frame policy per router before its caches are populated: a
process-global override would make concurrent native planning unsafe, while
changing the native load default would needlessly disturb deterministic output.
An interleaved release A/B over the real AC20 mapped-member
`plan_appearance` path also retained the same source-index checksum and
fingerprint with no slowdown. The final implementation evaluates the canonical
surface once and shares that mesh between replacement and fingerprinting; a
second identity-only evaluation was measured and removed before review.

### Shared appearance atlas sampling (#4381)

Factoring target appearance preservation, charts and canonical image binding into
an internal sampler retains the finite-page operation and avoids a second atlas
pipeline for scan observations. Interleaved native AC20 base/extraction/transfer
probes found no resolvable ordinary-load regression, with identical geometry
counts and ordered fingerprints. This is a load-path isolation verdict, not a
browser worker-pool speedup or authoring-capacity claim. Keep expensive source
matching opt-in and separately bounded; broad transfer needs its own measured
candidate-reuse work. [Raw probes and limits](../../docs/architecture/evidence/shared-atlas/native-load.json)
record the comparison.


The registered mesh-transfer foundation preserves that ordinary-load isolation,
but its aggregate per-texel BVH work cap refuses the complete captured boulder.
A bounded prefix qualifies the surface/UV and unknown-coverage behavior; it does
not establish broad authoring capacity. The next mechanism to evaluate is
conservative candidate reuse across target triangles/tiles, retaining nearest
surface refusal and one atomic result, rather than enlarging the work ceiling.
[Real-surface coverage and refusal evidence](../../docs/architecture/evidence/mesh-transfer/README.md#real-boulder-geometry-conservative-coverage-and-capacity)
keeps that limitation separate from the ordinary-load measurements.

The emitted-texel applicability follow-up separates geometric centroid evidence
from pixels actually sampled into a transfer atlas. Ordinary-load paired probes
show mixed subphase differences at the probe's millisecond precision, with the
same ordered mesh payload fingerprint; no consistently directed change or
worker-pool speedup is claimed. The correctness result is refusing an all-old
atlas despite positive centroid coverage while retaining byte-identical dense
transfer output. [Samples, fingerprints and PNG evidence](../../docs/architecture/evidence/mesh-transfer-texel-gate/README.md)
record that distinction.

Canonical occurrence source snapshots reuse the mesh already evaluated by the
opt-in appearance planner. Moving its bounded vectors into the plan avoids
reconstructing IFC geometry from GPU instance transforms. Interleaved exact-base
native AC20 probes found no resolvable ordinary-load change and identical geometry
counts. This establishes load-path isolation, not a browser worker-pool speedup
or conversion throughput claim; the additional authored payload remains governed
by the existing aggregate geometry budget.
[Source-mesh payload probe](../../docs/architecture/evidence/evaluated-occurrences/source-mesh-load.json)
records source heads, precision limits and the unchanged census.

Candidate reuse for registered transfer was tested through whole-triangle leaf
caches, exact observation memoization, lazy spatial cells, and conservative
centroid-witness seed bounds. These preserve bounded controls but still exceed
the complete captured-boulder work quota; none was merged. A calculation-only
fresh-worker diagnostic separates actual traversal latency/memory from the work
proxy, without authorizing a larger quota or producing an applicable plan.
Do not repeat those cache mechanisms unchanged or infer broad capacity from a
small target prefix. [Recorded experiments and worker evidence](../../docs/architecture/evidence/mesh-transfer-capacity/README.md)
state the remaining gate and the limits of the measurement.


The follow-up nearest-first BVH experiment shrank an exact per-sample search
bound, retained the near-tie band in one traversal, and combined it with bounded
exact observation memoization. It still refused the full selected boulder under
the existing work cap, so the runtime experiment remains unmerged. A tighter
candidate search alone did not establish complete-target capacity; do not
reintroduce this variant as a shipped optimization without new end-to-end
acceptance. [Reproducible refusal](../../docs/architecture/evidence/mesh-transfer-capacity/README.md#nearest-first-traversal-follow-up).

### Product-scoped polygonal annotation fills (#4406)

Direct annotation fills reuse canonical placement/triangulation and a lazy
source-owned inverse style index shared across recreated native/batch decoders.
The ordinary AC20 source-matched A/B/A/B probe found identical paired reported
best-of-five phase timings and identical mesh fingerprints/counts; this is a normal-load regression
check, not annotation throughput or worker-pool speedup evidence. Keep style
lookup failures cached and diagnostic, and keep auxiliary type maps excluded.
[Exact inputs and paired runs](../../docs/architecture/evidence/annotation-fills/native-load.json).

### PDF vector graphics-state preparation (#4406)

The opt-in decoded-state preparation API adds no ordinary IFC geometry processing
step. An idle source-matched native A/B/A/B probe showed small millisecond timing
variation with identical ordered mesh fingerprints and counts. It does not
establish zero overhead, a worker-pool speedup or vector-page preparation
throughput. Keep page operator/path/stack limits distinct from PDF.js decoder
allocation limits; post-decode counting cannot bound the decoder's earlier work.
See [exact source IDs, five-iteration samples and identity evidence](../../docs/architecture/evidence/pdf-vector-state/native-load.json).

## Reference opening semantics (#4433)

An element-aware representation predicate excludes non-subtractive Reference
shapes only for opening elements. Controlled native base/branch probes on AC20
and ISSUE_129 resolved no material normal-load regression; mesh, vertex and
triangle counts stayed identical. This is a correctness change, not a speedup.
The lesson is to preserve the existing type-based rendering predicate for
ordinary products while applying opening-specific semantics consistently to
mesh production and fast void probes. Numeric evidence and source revisions are
in `docs/architecture/evidence/evaluated-openings/performance.json`.

### Reference-only opening host routing (#4440)

A retained Reference-only opening must keep its host on the textured submesh
path. The new predicate inspects representation membership without producing
cutter meshes; unknown or over-budget data retains the existing cutter path.
Two interleaved base/branch native probe pairs on AC20 and ISSUE_129 resolved no
consistent material normal-load regression, with unchanged mesh/vertex/triangle
counts and existing CSG diagnostics. This is a correctness fix, not a browser
worker-pool speedup claim; small overhead below run-to-run variation remains
unresolved. [Exact revisions, probe results and limits](../../docs/architecture/evidence/evaluated-openings/reference-textures.json)
are recorded with the fixture evidence. Do not infer that a nonempty void-index
entry implies actual subtraction: the opening representation identifier matters.

## Shared authored source context (#4406)

Extracting common creator setup resolved no normal-load timing difference in
interleaved exact-source native probes, with identical ordered mesh fingerprints
and counts. Independently rebuilt WASM modules also returned byte-identical
complete plans for the checked annotation/captured controls. This is a reuse
prerequisite, not an optimization or an authoring-throughput claim. Reuse the
canonical source, placement and row author when adding non-image geometry; do
not introduce a dummy texture to access shared setup. See the [raw native
measurements](../../docs/architecture/evidence/authored-context/native-load.json)
and adjacent plan identity evidence.

### Complete selected-target mesh transfer (#4381)

Nearest-first traversal plus same-chart raster padding avoids source queries
for unobserved padding while retaining exact nearest/ambiguity checks and all
interior unknown appearance. Combined with an explicit aggregate work allowance
increase, the full selected boulder now returns identical applicable plans in
fresh workers and passes the normal viewer transaction/export/reopen journey.
The original quota experiments remain negative; neither this result nor the
quota increase alone retroactively turns them into wins. Scan-owned memory is
still bounded, including padding scratch, and overlapping/dense cases refuse
before publication. Ordinary-load paired probes had a slower first candidate
pair and matching second pair with identical ordered geometry; no consistent
regression or zero-overhead claim follows. This is measured capacity acceptance, not a throughput
speedup. [Worker, independent-reader and refusal evidence](../../docs/architecture/evidence/mesh-transfer-full-target/README.md).

### Behind-surface refusal for thin-wall transfer (#4381)

Registered mesh transfer now refuses a same-facing nearest scan surface that
lies deeper than an explicit `maxBehindMetres` behind the IFC face. The
controlled 4 mm partition showed the gap the symmetric distance bound left
open: with a 20 mm bound, a surface 10 mm beyond the wall painted the near face
although both faces were classified correctly against each other. The check is
one closest-point dot product after the existing nearest/ambiguity/normal
refusals, so it adds no BVH work; a coplanar capture is tolerated within f64
rounding under a zero bound because the centroid-only control runs exactly
there. Interleaved native AC20 A/B/A/B probes on a shared host found equal
best totals within run spread and identical ordered geometry fingerprints and
counts; the sampler is not on the load path, so this is only a no-regression
control, not a transfer-throughput claim. The lesson is that nearest-first
matching needs a signed depth bound, not a larger symmetric one: relaxing the
distance bound to reach the opposite face reintroduces every far-side bleed.
See the [controls and raw probe samples](../../docs/architecture/evidence/mesh-transfer-surfaces/README.md).

### RGB point-cloud transfer source (#4381)

The registered transfer source became a tagged union and gained an RGB
point-cloud path: a bounded uniform grid (16 bytes/point) instead of a BVH leaf
per point, a least-squares plane per sample, and a target self-occlusion rule
that costs two budgeted BVH ray queries per sample (exact segment for the
nearest point, one thickness probe for the rest of the support) after a first
version that spent one ray per supporting point exhausted the 128 M budget on a
real 25 m² wall. Review then added the nearest-face rule for unoriented
captures inside the solid: a sample whose nearest capture lies deeper inside
than one surface band pays one wider query out to the distance bound to look
for a capture in front, and the support is regathered around the nearest point
whenever it lies farther than half the radius. On the CRAS corridor drywall the
accepted plan used 43.5 M of 128 M units in 376 ms (Node, 465 k points,
64 texels/m); the windowed north wall with both faces scanned was refused at
64 texels/m and accepted at 32 (59.5 M units, 331 ms; 49.0 M before the rule),
so the planner now reports `budget.workUsed` next to coverage. Interleaved
native AC20 A/B/A/B probes on a shared host at the final head: best totals
16/15 ms (base 1996e9281) vs 14/15 ms (branch), identical mesh/vertex/triangle
counts (285 / 35,940 / 19,456) and identical ordered geometry fingerprint
`25ac885b6ff4ad00` in all four runs — no load-path regression, and, as before,
only a control: the sampler is not on the load path. Lesson: for point sources
the per-sample cost is set by point density times the support area, not by the
point count, so the grid cell must follow the support radius and any per-point
occlusion test must be replaced by a per-sample one. See the
[real-pair evidence](../../docs/architecture/evidence/scan-registration-cras/README.md).

## Qualified PDF fill composition (#4406)

The new explicit creation API leaves ordinary model loading on the existing
path. Interleaved exact-source native probes showed a slower first candidate
pair and matching second-pair timings, with identical ordered mesh fingerprints
and counts. This resolves no consistent normal-load regression and does not
establish zero overhead or browser-worker throughput. The composition budget
precharges pairwise overlay work and separately limits generated contours and
transport; do not tune those caps using unrelated normal-load timings. See
[raw samples and source identity](../../docs/architecture/evidence/pdf-fill-annotations/native-load.json).

## Qualified curved PDF fill boundaries (#4406)

Native normal-load A/B/A/B resolved no consistent regression, with identical
ordered mesh fingerprints and counts. This does not measure curved-page worker
throughput. Subdivision and original-piece hull qualification share the existing
creation budget; finely tessellated holes can still refuse its overlay work cap.
Do not silently coarsen to fit it. A global exact convex-control-polygon check
rejected a real sheared control on tiny near-collinear turns; exact per-piece
hull separation admitted that control without snapping or ignoring features.
Keep finite-chord error bounds: infinite-line flatness incorrectly collapses
backtracking curves. See [source-matched samples](../../docs/architecture/evidence/pdf-curved-fill-annotations/native-load.json)
and the adjacent independently decoded PDF evidence.

### Evaluated post-opening appearance and companion history (#4404)

The authoring evaluator now consumes canonical post-opening source geometry and
carries bounded opening companion meshes for one preview/history transaction.
Controlled native normal-load A/B probes retained equal geometry counts. The
small AC20 fixture showed a slight absolute increase at coarse phase resolution;
the opening-heavy control stayed close across both interleaved pairs. No speedup
or browser worker-pool timing claim is made. See the
[measured source revisions and results](../../docs/architecture/evidence/evaluated-openings/authoring-performance.json).
This changes the authoring path, not the normal-load mesh evaluator; future
optimization should measure the explicit conversion workload independently.

## Version-bound closed PDF dashes (#4583, #4406)

Closed-dash interpretation is confined to opt-in PDF preparation and annotation
planning. Independently compiled base/branch then branch/base native-load
controls on AC20-FZK-Haus retained identical ordered mesh fingerprint
`25ac885b6ff4ad00` and counts (285 meshes, 35,940 vertices, 19,456 triangles)
in all 20 iterations. Paired wall-time medians were 14.28/16.03 ms and
14.45/14.65 ms; the second pair nearly converges and the absolute differences
are below the probe's useful phase resolution, so no material ordinary-load
regression is observed. This is not a PDF-planning or browser-worker throughput
measurement. The useful lesson is semantic: the effective PDF version must be
bound before geometry because the compatibility policy caps a PDF 1.x
closed-dash seam while PDF 2.0 explicitly requires a join, and a mature
independent reader may still render the capped form for both. See the
[paired raw runs and reader evidence](../../docs/architecture/evidence/pdf-closed-dash-annotations/README.md).

## Qualified solid straight PDF strokes (#4406)

Fresh exact-source native A/B, A/B, then reverse B/A normal-load controls for
the round-cap/join expansion resolve no regression. The warmed pairs reported
base/branch totals of 9/8 ms, 9/9 ms, then branch/base totals of 8/9 ms, while
mesh, vertex and triangle counts and every ordered mesh fingerprint remained
identical. This isolates the normal IFC load path; it does
not measure opt-in PDF authoring or worker-pool throughput. Stable sagitta
inversion also reduced the independent round controls' bounded planner work and
triangle counts without changing analytic acceptance; the source-specific
oracle carries those measurements. A draft union
of segment rectangles and join wedges was rejected by existing conservative
contact/intersection guards even on ordinary joins; direct offset contours
retain the same guards and avoid manufacturing those internal boundaries.
Collapsed/reversing offsets and unresolved joins refuse rather than repairing
an unqualified stroke arrangement. See the [source-specific raw controls](../../docs/architecture/evidence/pdf-straight-stroke-annotations/native-load.json)
and original PDF/independent IFC evidence alongside them.

## Symbolic fill routing for native annotation meshes (#4459)

Source-specific native A/B/A/B controls retain identical ordered geometry
fingerprints and counts. The candidate's first launch is slightly slower at
coarse phase resolution; the second pair matches. This is normal-load
isolation, not a symbolic-extraction or browser worker-pool performance claim.
The lesson is to carry qualified item provenance once, then filter the 3D
overlay output; deleting the shared drawing primitives would hide the duplicate
at the cost of 2D content. See the [raw runs and immutable binary identities](../../docs/architecture/evidence/annotation-fill-routing/native-load.json).

## One integer lattice for registered PDF composition (#4458)

Exact-source interleaved normal-load probes resolve no regression; both paired
phase minima and all ordered mesh fingerprints/counts are identical. This does
not measure PDF authoring or worker throughput. The useful mechanism is retaining
integer groups through classification, clipping and paint ordering: repeatedly
creating floating adapters had shifted a shared CropBox edge enough to trigger
a false topology refusal. Source qualification now happens once, and every stage
still checks finite-edge topology. A separate finite-segment separation
certificate avoids treating an unrelated infinite-line side change as an edge
intersection. No tolerance/endpoint guard was replaced by epsilon snapping.
[Source-matched raw samples and original PDF evidence](../../docs/architecture/evidence/pdf-composition-lattice/README.md)
record the control and prevent repeating the float-roundtrip approach.

## Regime-1 coincidence requires near-parallel planes (#4439)

The exact boolean classifier's "sub-triangle lies ON a coincident shared face"
regime now also requires the sub-triangle's own plane to be within 45° of the
candidate face (`coincident_planes`, a sqrt-free `2·d² ≥ |n₁|²|n₂|²` test on
products the classifier already forms). Interleaved native A/B/A/B on AC20 and
ISSUE_129 resolved no phase delta beyond the base's own noise floor; AC20's
ordered mesh fingerprint is identical on every run. ISSUE_129's output changes
on purpose: host #9094 is one of the 17 census hosts the gate reclassifies
(triangle delta of the whole run equals that row's census delta), so its timing
is not a like-for-like comparison and is not claimed either way. This is a
correctness fix, not a speedup. The lesson: a centroid-in-band test locates a
face, it does not establish coincidence — a needle hugging the intersection
line of two transversal faces sits in both planes' bands with no orientation to
agree with, and a `dot > 0` verdict there is a coin flip that can override an
exact ray-cast. Add the angle premise per candidate face rather than gating on
a parent flag (the parent-flag gate was measured to cost 20+ census hosts).
[Raw interleaved runs and fingerprints](../../docs/architecture/evidence/csg-coincident-planes/native-load.json).
Found while measuring: on Windows `ab.sh` ran ZERO rounds and still printed a
"within noise, counts matched" verdict, because `ab-order.mjs`'s CLI guard
compared `import.meta.url` with a backslash `argv[1]` and never fired. Fixed in
the same PR (`pathToFileURL`, a CLI test, and `ab.sh` now refuses an order file
with fewer lines than `--iters`); the recorded runs replicate the procedure by
hand with the same `roundOrder()` and reporter.

## PDF fidelity report and partial acceptance (#4406)

Bounded graphics-state preparation now interprets forms, groups, annotation
appearances, clips, ExtGState dictionaries, optional content, text, images and
stroke features into a page-level fidelity report, and fill planning records
the accepted verdict in a provenance property set. None of this is on the
parse or element-geometry path. An interleaved base/branch/base/branch native
AC20-FZK-Haus probe (5 iterations each) retained identical ordered mesh
fingerprints and mesh/vertex/triangle counts in all 20 iterations; total-phase
medians were 13 and 20 ms on base against 24 and 19 ms on the branch, so the
base-to-base spread exceeds any base/branch difference and no regression is
observed. The host was shared with other builds during the first branch pair,
which the raw record states. The verdict is no material regression on that
fixture, not a PDF-preparation throughput claim: the report interpreter is
bounded by the existing operation, path-number and save-depth budgets plus a
4,096-entry listed-omission cap with complete summary counts. See the
[raw runs](../../docs/architecture/evidence/pdf-fidelity-report/native-load.json).

## Mixed planar and residual opening compatibility (#4610)

Interleaved native end-to-end probes show byte-identical AC20 output and no
material phase change. ISSUE_129 intentionally restores the exact mesh,
vertex, and triangle counts from immediately before #4579; its comparison with
the regressed parent is not like-for-like because the parent dropped geometry.
A separate interleaved comparison against that pre-regression commit produced
identical output and timings within run-to-run noise. The discarded topology
fallback was materially slower because it built both the torn hybrid candidate
and the full-context candidate. The useful lesson is to quarantine a known
composition incompatibility before doing either expensive route, while keeping
the public and pure-2D union operation correct; #4617 owns removing that
temporary boundary once mixed routing can preserve both union semantics and
final topology.

## Comment-free STEP point-list scan (#4735)

The record scanner now proves once that a point-list tail contains no STEP
comments before entering its per-item delimiter loop; commented records retain
the original comment-aware path. Source-matched interleaved native probes and
fresh Chromium worker-pool loads of AC20-FZK-Haus retained identical ordered
geometry fingerprints or mesh counts. Their base/branch phase differences all
stayed within run-to-run noise, so the verdict is no material full-load
regression and no demonstrated end-to-end speedup. The useful lesson is that a
tighter inner loop is not itself a user-visible performance claim: retain the
single outer proof, but judge it through the full parser and browser worker
pool, where geometry and startup dominate this small fixture.

## Exact emitted RTC frames for auxiliary geometry (#4799)

The additive frame-aware grid, alignment and symbolic parsers reuse the exact
RTC decision emitted by the mesh pre-pass; standalone callers retain whole-file
detection. Five balanced native AC20-FZK-Haus base/branch rounds against
`3b10435ab117b1fcaf3ad7c47f7d9fdf74e0f2a4` kept the ordered mesh fingerprint
`25ac885b6ff4ad00` and the 285 meshes / 35,940 vertices / 19,456 triangles
identical. Parse and total medians were 7 ms and 17 ms on both sides; geometry
was 9 -> 10 ms inside the base's 11% spread. This is ordinary-load isolation,
not an overlay speedup claim.

Five fresh Chromium pairs on the complete contract plus viewer integration all
used the default eight-worker pool and produced 317 meshes / 44,249 entities.
Base -> branch medians were 538 -> 570 ms first-visible, 511 -> 533 ms stream,
658 -> 712 ms metadata and 782 -> 794 ms observed metadata-plus-render. No
metric exceeded its measured noise, but the base readiness spread was 24.94%,
above the reporter's 20% limit, so the browser cohort is explicitly **too
noisy** and supports neither a regression qualification nor a speedup claim.
The browser harness records mesh/entity counts rather than vertex-payload
identity; the native ordered fingerprint supplies that separate identity
control. Explicit-frame-versus-standalone parser microbenchmarks are only
supplementary mode timings, not full-load evidence.

## Precision-derived RTC gate (#4934)

Lowered `LARGE_COORD_THRESHOLD_METERS` from 10 km to 1 km. Base
(521e8d8e9) vs branch, native `perf_probe` on AC20-FZK-Haus (best-of-5,
interleaved): total 15 ms both sides, parse 7 ms / geometry 7 ms both
sides. Mesh output byte-identical: 285 meshes / 35,940 vertices /
19,456 triangles on both, and this fixture's coordinates sit well under
1 km so the gate's `Small` verdict — and therefore the mesh frame — is
unchanged either side; the lever this PR pulls has no reach into
AC20-sized files. The lesson: a threshold-only change with no new work
in the hot path needs no dedicated perf lever, only a byte-identity
check on a fixture the gate does not touch; the real cost of moving the
line is paid only by files that cross between the old and new bands
(1-10 km), which this fixture is not one of.

## Kernel-plane tags for consolidate's rounding-split fix (#3914)

`kernel::mesh_bridge::tris_to_mesh` now tags every output triangle with its
f64 supporting plane (`Mesh::plane_tags`) and `consolidate_coplanar` validates
each tag (a per-triangle supporting-plane check) and cross-checks adjacent
`POS_QUANT`-bucket pairs against it before merging any of them. On
AC20-FZK-Haus (no CSG cuts in this fixture) output was byte-identical
(285 meshes / 35,940 vertices / 19,456 triangles both sides) and total time
was noise-dominated at this file's scale — nothing in the hot path runs
differently when a mesh carries no tags or a bucket has no rounding-split
neighbour, which is the overwhelming majority case. On the CSG-heavy
ISSUE_129 fixture the new merge pass legitimately fires: output triangle/
vertex counts drop slightly (fewer, correctly-merged coplanar triangles
where a physical plane used to be torn across two buckets), confirmed
non-regressive by the full `triangulation_invariance` census/golden suite
passing (previously two hosts in that suite — `issue_129_mixed_bool2d_
residual_preserves_established_topology` and `issue_4627_candidate_
failures_preserve_prior_analytic_cuts` — caught two earlier, broader
variants of this fix that keyed EVERY bucket by the kernel tag instead of
only merging validated adjacent pairs). Lesson: for a per-triangle
provenance tag meant to correct a narrow rounding edge case, do not let it
become the primary bucketing key everywhere it validates — real models
carry legitimately distinct near-coplanar faces (the #3913 sweep's
deliberate `SNAP_GRID` controls) that a blanket re-key cannot tell apart
from a genuine rounding split; gate the tag's effect to the specific
adjacent-bucket-pair mechanism the defect actually is, with a tolerance
tight against the true-positive margin (~1e-10) and far below the
legitimate-distinct-plane separation (~1.5e-5).

## Deterministic B-spline degree/control-point budget, memoized Cox-de Boor (#4901)

Base `0d84727c5` vs branch, native `perf_probe` (best-of-5): AC20-FZK-Haus
14 ms both sides (285 meshes / 35,940 vertices / 19,456 triangles,
byte-identical); ISSUE_129 CSG fixture 912 -> 910 ms (within noise), 1,402
meshes / 219,860 vertices / 135,749 triangles / 41 CSG failures / 6 degenerate
dropped, identical on both sides. Neither fixture carries a B-spline surface
or curve, so this is an isolation check, not a speedup claim. The fixture that
DOES (`tests/models/issues/472_2222.ifc`, issue #472, 145 B-spline surfaces /
503 B-spline curves) is covered by `geometry_correctness_harness`'s pinned
snapshot instead of a timing probe: 53,479 triangles / 33,069 vertices,
byte-identical base vs branch.

The lever itself: `bspline_basis` (Cox-de Boor recursion,
`rust/geometry/src/processors/advanced_face/bspline.rs`) was called once per
control-point index with no caching between calls, so it re-derived the same
sub-results `O(control points)` times per sample point on top of being
`O(2^degree)` unmemoized — a file-supplied `Degree` in the tens already made a
single face non-terminating in practice, and nothing bounded it. Replaced with
one bottom-up table build per sample point per axis (`bspline_basis_table`,
`O(degree * (n + degree))`, mathematically identical, so legitimate output is
byte-for-bit unchanged — pure caching, not a formula change) plus a
deterministic (not wall-clock) degree cap (`bspline_budget.rs`) so a file that
still exceeds it fails loudly via `GeometryRouter::record_unsupported_item`
instead of hanging.

**Dead end, caught before merge, worth recording:** the first cut also capped
raw `ControlPointsList` size (a flat `n_u * n_v` ceiling calibrated by guessing
"a few hundred is already a dense patch"). `geometry_correctness_harness`'s
pinned snapshot for the #472 fixture caught it immediately — that fixture's
worst surface is a REAL 207x180 (37,260-point) patch, and the flat cap
silently dropped it, losing exactly one tessellated face's 1,152 triangles
(53,479 -> 52,327). Replaced with a bound on the actual cost driver instead:
`(u_segments+1) * (v_segments+1) * n_u * n_v` (`MAX_BSPLINE_SURFACE_SAMPLE_WORK`,
since `evaluate_bspline_surface`'s weighted sum is `O(n_u * n_v)` PER SAMPLE
POINT, not once) — the #472 fixture's worst surface measures ~23.3M against a
500M bound. The lesson, twice over: an unmemoized recursive basis-function
evaluator is an easy trap in geometry code — it reads as "just math," but its
complexity is exponential in a file-controlled parameter, so it needs the same
file-driven-loop scrutiny as an explicit `for` loop over entity references —
AND a breadth cap must bound the same quantity the hot loop actually multiplies
out to (samples x grid, not grid alone), or a real fixture proves the guess
wrong. Always run the correctness harness against a fixture that exercises the
lever before trusting a calibrated constant.

## Wall-local vertical opening classification (#3977)

Exact-source native `perf_probe` comparison of base `6304b8ebc` and branch
`89b93e364` used five balanced, interleaved fresh-process rounds per fixture.
Median parse / geometry / total milliseconds were 8 / 11 / 19 -> 8 / 10 / 19
on AC20-FZK-Haus and 26 / 929 / 955 -> 28 / 930 / 958 on CSG-heavy ISSUE_129.
The heavy Holter control was deliberately included because the classifier runs
once per opening: its medians were 407 / 741 / 1,160 -> 403 / 752 / 1,155 ms.
Holter's geometry samples were noisy on both sides (base 455-774 ms, branch
430-775 ms), so the 1.5% geometry-median difference is not a regression signal;
its total median improved 0.4%. Every round retained identical output counts:
AC20 285 meshes / 35,940 vertices / 19,456 triangles / 0 failures, ISSUE_129
1,402 / 219,848 / 135,737 / 41, and Holter 109,514 / 4,502,946 / 2,882,383 /
0. Verdict: no material full-load regression and no performance claim.

The source-matched browser worker-pool control compared the same base with
`cb7557caa` in five interleaved fresh-Chromium-process pairs per fixture. The
observed metadata-plus-render median was 479 -> 483 ms on AC20 (+0.8%, below
the base's 7% spread), 1,862 -> 1,860 ms on ISSUE_129 (-0.1%, below 5%), and
5,114 -> 5,084 ms on Holter (-0.6%, below 17%). First geometry, first visible,
stream completion, spatial readiness, metadata completion, and the legacy app
total likewise stayed inside their respective noise floors. Every round kept
the same total mesh count between revisions. This qualifies the actual browser
worker path as well as the native phase split; it does not qualify search,
cache-tail memory, properties, picking, or Firefox.

The lesson is to scope authored-depth preservation to the vertical-depth
selector itself. Applying it to the established horizontal-depth route changed
real heavy-model cuts even though small synthetic cases remained green; the
heavy census caught that overreach, and restoring the old horizontal route
removed every branch-caused census delta.

## Hole-wall winding and host-derived wall frames (#5410)

Correctness change, no performance claim. Extruded profile holes now emit side
walls wound into the void, so a voided host reaches the exact kernel as a
consistently wound solid, and a plan-rotated wall whose cutters author no depth
is cut in its own frame. Native `perf_probe` base `04dd98f96` vs branch, three
interleaved rounds of best-of-3 per fixture, median parse / geometry / total ms:
AC20-FZK-Haus 8 / 28 / 36 -> 9 / 24 / 33 (byte-identical ordered fingerprint),
ISSUE_129 30 / 1,164 / 1,194 -> 30 / 1,157 / 1,182, Holter 463 / 945 / 1,409
-> 465 / 598 / 1,146 (Holter's totals spread 977-1,711 ms on base, so its
geometry delta is noise, not a win). Mesh, vertex, triangle and CSG-failure
counts are identical on all three; ISSUE_129 and Holter fingerprints differ
only in normals of holed extrusions, which the output orienter used to flip and
recompute. The lesson: an extruder's winding is an input contract of the
kernel, not a rendering detail the output orienter may repair afterwards.
After review folded the three side-wall builders onto one shared orientation
helper, a re-run against `ea4cc3718` (eight interleaved rounds) gave AC20 and
ISSUE_129 byte-identical fingerprints to main; ISSUE_129 per-round best totals
spread 1,178-1,951 ms on main and 1,143-1,873 ms on the branch on a loaded
host, so the medians' order (1,391 vs 1,476 ms) is not a signal either way.

## Structural curved/oriented edge rendering, no reach into either fixture (#4206, #5020)

Native `perf_probe` comparison of base `0e8a42175` (merge-base with `origin/main`)
and branch `9a469537b` (this PR merged onto that base), five balanced,
interleaved fresh-process rounds per fixture, `--iters 5 --json --fingerprint`.
Neither in-tree fixture instantiates a standalone `IfcEdge`/`IfcEdgeCurve`/
`IfcOrientedEdge` as a geometry item, so `IfcEdgeProcessor::process` (the only
code this PR touches) never runs on them: this is an isolation check, not a
speedup claim, and the ordered mesh FNV was byte-identical on every one of the
25 runs per fixture per side.

AC20-FZK-Haus: median parse/geometry/total (best-of-5) 8/7/15 ms (base) vs
8/7/16 ms (branch); median full-pipeline wall 18.0 ms (base, spread 16.8-22.4)
vs 18.3 ms (branch, spread 17.1-26.2) — branch sits inside the base's own
spread. Output identical both sides: 285 meshes / 35,940 vertices / 19,456
triangles / 0 CSG failures, fingerprint `25ac885b6ff4ad00` on all 50 runs.

`C20-Institute-Var-2.ifc` (10.3 MB, 147,712 entities): median parse/geometry/
total 44/47/92 ms (base, total spread 89-104) vs 48/51/102 ms (branch, total
spread 86-133); median full-pipeline wall 111.5 ms (base, spread 103.2-145.3)
vs 121.4 ms (branch, spread 98.4-191.9). The branch's one high outlier (a
133 ms total / 191.9 ms wall round, immediately following an unusually fast
89 ms base round in the same interleaved pair) drove most of the median gap;
excluding it drops the branch median to within 4% of base. Both branch median
figures fall inside the base's own measured range, so this is noise from a
10 MB/147k-entity file's larger absolute jitter budget, not a signal: output
was identical on every round, 2,668 meshes / 83,310 vertices / 51,682 triangles
/ 0 CSG failures, fingerprint `3616a1e7d01c6950` on all 50 runs.

Verdict: no measurable full-load regression on either fixture, and none
expected — the new ribbon-mesh path only activates for a structural curve
member's raw edge entities, which neither architectural fixture contains.
Lesson: for a processor gated on IFC types absent from the standard perf
corpus, the correct "perf verdict" is an isolation proof (identical mesh
counts and fingerprint, timing inside noise) rather than a speedup or
regression claim — don't force a delta narrative onto a lever that has no
reach into the fixtures the ledger already tracks.

## Direct attribute construction (#5324, rejected)

A shared STEP grammar with separate token and attribute construction sinks
removed intermediate nested token vectors from full decode. Compaction was
needed to avoid retaining the parser's geometric vector capacity. The final
seven-model alternating native cohort preserved ordered geometry fingerprints,
counts and diagnostics, but did not establish a meaningful complete-load win:
results were mixed, with slower control medians and substantial Holter variation.
The candidate was rejected before browser qualification; no WASM speedup or
memory improvement is established. The lesson is to qualify the whole decode
consumer, including final vector capacity and existing cache fast paths, rather
than infer load improvement from removing an intermediate tree.

[Complete rejected source, measurements and limits](evidence/direct-attributes-5324/README.md).

## Surface spline sample reuse (#5321)

Surface evaluation reuses axis samples and removes only exact-zero coefficients,
keeping the order and threshold of the dense weighted sum. A bounded sparse-sample
cache also handles malformed knot vectors with dense support without retaining
all their samples. The existing degree and work-admission budgets stay unchanged.

Five alternating fresh-process native pairs improved full-call load on the real
spline fixture in every pair; the four control-model medians remained within
observed variation. Ordered mesh fingerprints, counts and diagnostics matched in
all samples. Real WASM prepass/batch comparisons also retained exact geometry
payloads at three detail levels. This establishes no browser speedup by itself.
Five alternating fresh-process browser pairs per fixture completed without
load/GPU errors on the same target and controls. Readiness changes were mixed
within run variation and target geometry-streaming was flat: no demonstrated
browser speedup. The adapter was SwiftShader; RSS sampling is a coarse sum of
owned processes through a fixed post-readiness tail, not cache-settled memory.
See [evidence and measurement limits](evidence/spline-5321/README.md).


## Multipart mapped occurrences: parked (#5328)

An opt-in prototype kept per-source-part identity through canonical production,
WASM shard recovery and the native USD consumer. Fixture-backed workspace tests,
strict clippy, real WASM contracts and independent composed-USD geometry checks
passed. No meaningful complete-load benefit was qualified: native flat Holter
signals reversed across an A/A-controlled follow-up, native export timings were
mixed and later overlapped unrelated host work, and a browser timing attempt was
interrupted for the same contention. Smaller serialized output is not a load
win. Preserve the rejected source, observer failures, completed functional checks
and every timing cohort in [the experiment record](evidence/multipart-5328/README.md).
No runtime change from this prototype ships.

## Physical summary membership scan (#5477)

The viewer now visits candidate source type buckets when collecting physical
entities, while retaining canonical overlay semantics, and memoizes metadata
panel membership across geometry-only updates. The first two fresh-browser
Holter cohorts were too noisy for a verdict and remain in the evidence. A
third, more isolated alternating cohort cleared the existing base-spread noise
limit, improved every paired browser-readiness comparison, and met the Holter
browser gate on every candidate run. Geometry counts, visible metadata, GPU
picking and selection remained consistent. Three post-result launcher races
left missing method files; pre-load process/variant proofs and complete browser
results survive for every sample. The result measures full model/index/canvas
readiness, not worker geometry alone. AC20 and ISSUE_129 control medians stayed
close to base, with matching output counts and functional checks. The lesson is to profile React
publication work on large entity stores: repeated whole-store scans can
dominate after worker geometry has finished. See the
[sample-level browser evidence](evidence/physical-summary-5477/README.md).

## Edge-grazing half-space cap repair (#5314)

The cap builder now ignores triangles that collapse after its section-vertex
weld. This reaches edge-grazing `IfcHalfSpaceSolid` cuts; the inline #30 and
Holter #148571 regression tests show a closed section with the analytic prism
volume. Five alternating fresh-process base-vs-branch native
`perf_probe --iters 5 --json --fingerprint` pairs covered AC20-FZK-Haus,
ISSUE_129 and Holter. AC20's ordered mesh fingerprint and counts stayed
byte-identical. ISSUE_129 and Holter emitted more vertices and triangles from
the intended caps, with stable but changed ordered fingerprints on every run.
Parse, geometry and total times varied widely on the shared WSL host; paired
samples crossed in both directions. The run establishes neither a speed gain
nor a regression. The numeric A/B evidence lives in the PR, not this ledger.

The lesson is that a small boundary-accounting guard can repair many reused
Boolean items. Full-load counts and ordered fingerprints reveal its reach
where a single-element test cannot, while variable host timing should not be
sold as a speed verdict.

## Viewer ancestor subscriptions and transient-upload screen (#5555)

A post-summary-fix production profile showed distributed React reconciliation
and renderer staging rather than another dominant metadata panel. Narrowing
subscriptions in the two viewer ancestors improved one interleaved Holter pair
and regressed the other, so the bounded screen did not justify shipping it.
A separate diagnostic retained only the first streaming preview and skipped
later transient uploads before normal finalization; it improved both pairs but
missed the predeclared investment gate for a larger renderer redesign. That
diagnostic deliberately reduces progressive display and must not ship.

Both patches remain unapplied in the [complete screen evidence](../../docs/architecture/evidence/viewer-ancestor-screen-5555/README.md).
The experiment reused identical frozen WASM with current JavaScript, so it is
an investment screen, not source-matched shipping qualification. All attempts
and provenance are retained. Lesson: a large inclusive React sample bucket does
not establish that removing a framework or a few subscriptions buys the same
wall time; test the actual change, and measure the avoidable upload work before
committing to permanent renderer pages.

## IFC4x3 alignment geometry on Viadotto Acerno (#5327)

Five interleaved native base-versus-branch runs covered AC20-FZK-Haus and the
source-verified Viadotto Acerno fixture. AC20 emitted identical mesh, vertex,
and triangle counts. Its parse, geometry, and total timings all fell within
the wide run-to-run noise. Viadotto emitted additional meshes and triangles
because the branch now generates its sectioned solids; its timing comparison
is therefore not like-for-like. No measurable end-to-end speed verdict follows
from either fixture. The numeric A/B evidence is in the PR.

The incremental clothoid sampler avoids repeatedly integrating from the
origin for each station. A follow-up review found that inverting 3D station
length still rescanned every densely sampled horizontal segment and vertical
profile segment at each integration point; those lookups now use their sorted
station keys. The final interleaved A/B kept AC20's output counts identical
and its phase timings within noise. Viadotto again emitted the intended extra
geometry, so its timing remains non-comparable. The lesson is to check
complete model output before interpreting alignment timings and to trace
the lookup cost inside each repeated station evaluation.
