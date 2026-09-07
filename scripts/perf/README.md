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

## Lever ledger (read before spiking)

### Incremental affinity publication (#4051)

Publish each existing bulk job chunk after its routing keys are ready, keeping
the shared decoder/signature memo and exact payload order. The
[local evidence](./evidence/affinity-publication-2026-09-06/README.md) records a
large-MEP readiness benefit and its memory tradeoff, with much smaller effects
on the other measured models. This is not full-corpus or Firefox qualification.
The separate per-batch map-cache experiment is archived, not retained or added
to this candidate's savings. An intended combined build reused stale Cargo
output after source restoration preserved older timestamps; its original labels
are corrected explicitly in the evidence. Force actual Rust recompilation after
variant restoration: forced Turbo execution and matching bundled hashes alone
do not prove the restored source was compiled.

Encoded so a spike does not re-walk a dead end. History lives in the PRs cited.

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
- **GLB export computes georeferencing nobody on that path reads** (CANDIDATE — the cost is
  measured, the fix is not designed): `process_geometry`'s metadata block always runs the
  georeferencing extraction, and `rust/export` has no reference to
  `metadata.georeferencing` anywhere. The streaming GLB paths run the pipeline twice, so a
  large export pays it twice. After the index sharing above, what remains is the scan and
  decode: roughly 280 ms per pass on a 327 MB fixture, so about 560 ms on a streaming
  export. The field cannot simply go — the server serves it — so this needs an opt-out on
  the options struct, defaulting to on, plus a per-exporter audit. That is its own review
  unit and its own measurement, which is why it is not in the PR that shipped the sharing.
- **Brotli -q11 on the served bundle** (CANDIDATE — unvalidated): a single local estimate
  suggested Vercel serves ~1266 KB where brotli -q11 reaches ~947 KB (~25% smaller cold
  download). NOT confirmed against the real served response — Vercel controls its own
  on-the-fly compression and may override a precompressed asset, so this may not be
  realizable without platform support. Before claiming it: measure the actual
  `Content-Encoding`/transfer size of the deployed `.wasm` before vs after, on a clean
  deploy. Treat the 25% as preliminary context only.
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
- **`BVH.build` is a synchronous main-thread block that grows as O(N log^2 N)**
  (`packages/spatial/src/bvh.ts`, measured 2026-08-08, M-series, warmed, best of
  3): 21 ms @ 6.7k meshes, 296 ms @ 60k, 826 ms @ 120k, **1715 ms @ 200k**
  (3-5x that on a mid-range laptop). `buildSpatialIndexAsync` time-slices only
  phase 1 (the linear bounds pass) and calls phase 2 "fast enough
  synchronously"; phase 2 re-`sort()`s the index slice at *every* node, so the
  comparator runs 68 -> 132 times per mesh as N goes 6.7k -> 200k. NOT SHIPPED and
  not the cause of any open issue — recorded so the number does not get
  re-measured. The fix, if wanted, is a presorted-per-axis build (O(N log N))
  plus slicing phase 2; BVH query results are exact AABB tests at the leaves, so
  a different tree shape is output-equivalent and can be asserted as such.

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
reopening. The shared evidence below records coverage limits.


### Retained cold-load qualification and limitations (#3985, #3993)

The [retained evidence](./evidence/retained-cold-load-2026-09-06/README.md) separates
combined native, browser and isolated-layer outcomes. Native full-call corpus
loading improved with stable count and ordered-fingerprint witnesses; the
separate observable oracle retained exact output for its covered modes. Isolated
native layers were mixed, including a slower standalone ownership subset.

Chrome supplemental review found lower overall readiness time and memory, with
a consistent small-model readiness cost and slower geometry completion on some
models. Its original strict console audit remains failed: static-only captures
confirm a missing local analytics resource, while original per-event URLs were
not recorded. Firefox's original cohort remains invalid after a transient-child
memory-read failure and a long scheduling outlier. Later focus controls pass
but do not establish that historical cause or a corpus speedup.

Keep these limitations with the measurements. Neither isolated cleanup, a
prepared reload, a diagnostic profile nor an unrun experiment supplies a
throughput gain. No universal absence of performance regressions or target
corpus gain is claimed. Original failures and private exploratory work remain
archived; the published projections identify their source records by hash.

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

### Flat Y-up orientation and route-sensitive qualification (#4056)

The IFC-to-viewer map `(x, y, z) -> (x, z, -y)` preserves orientation. Removing the flat binding's extra triangle reversal aligns its winding with transformed normals and the native/IFNS route; a viewer geometry-output revision prevents old cached winding from surviving the correction. Simplification and native Y-up export conversion must use the same orientation-preserving convention. This is a correctness change, with no throughput gain claimed. Canonical native geometry and its determinism manifests are unchanged; converted flat indices intentionally differ. An actual WASM boundary contract fails on the old runtime and passes on the correction. A canonical geometry fingerprint cannot certify downstream coordinate conversion, and adaptive batch boundaries can expose a route-specific defect by moving otherwise identical entities between flat and instanced transport.

### Rejected: component parity BVH filtering (#4054)

A private spike replaced linear component parity candidate scans with conservative
BVH filtering while retaining the exact query endpoint and predicates. The cold-load
screen did not establish a substantial corpus gain; a renderer-finalization timeout,
teardown failures and unresolved raw geometry-channel differences prevent
qualification. Do not land or repeat this version without a new mechanism or
stronger evidence. A classification hotspot alone does not establish an end-to-end
win, and no component-size threshold is justified by these observations. The
[sanitized screen and limitations](evidence/component-parity-bvh-rejected-2026-09-07/README.md)
retain the rejected result independently of constraint-recovery and type-ordinal work.

### Rejected constraint-inventory vertex reuse (#4055)

Reusing the CDT constraint inventory during refinement did not establish a substantial cold-load improvement across the expanded corpus. The native processing probe showed a narrow improvement, while the corrected-orientation browser screen remained mixed and failed unchanged raw geometry, spatial-query and browser-lifecycle gates. Exact instrumented producer output on one fixture did not waive downstream browser mismatches. Failed teardown attempts and later contamination-uncertain attempts remain recorded separately from justified clean recovery runs. Stop this experiment without landing the candidate; do not repeat it on a microbenchmark, normalized mesh comparison or selected-fixture timing alone. The [rejected experiment evidence](evidence/rejected-vertex-reuse-2026-09-07/README.md) records the complete disposition and provenance limits.

### Correctness prerequisite: server JSON cache roundtrips (#4064)

Actual HTTP qualification exposed finite metadata coordinates changing during
JSON cache replay. Enabling the server's serde_json roundtrip parser preserves
those values without a geometry or tolerance change. The bounded fresh-process
screen retained exact cold geometry/data-model bytes and corrected replay parity;
it does not establish a performance gain or neutrality. Keep endpoint readiness,
cache completion and offline witness cost separate, and never extrapolate a
processing-probe gain to the shipping HTTP artifact.
[Sanitized screen and limitations](evidence/server-json-roundtrip-4064/README.md).
